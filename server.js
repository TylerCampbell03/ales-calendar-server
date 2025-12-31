require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configure web-push with VAPID keys
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Store subscriptions in memory (in production, use a database)
const subscriptions = new Map();

// Store events scheduled for push notifications
const scheduledEvents = new Map();

// ===== ENDPOINTS =====

// 1. Get VAPID Public Key (client needs this)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// 2. Subscribe to push notifications
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  // Store subscription with a unique ID (using endpoint as ID)
  subscriptions.set(subscription.endpoint, subscription);
  
  console.log('✓ New subscription received');
  console.log(`  Total subscribers: ${subscriptions.size}`);
  
  res.json({ success: true, message: 'Subscription saved' });
});

// 3. Unsubscribe from push notifications
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  
  if (subscriptions.has(endpoint)) {
    subscriptions.delete(endpoint);
    console.log(`✓ Unsubscribed: ${subscriptions.size} subscribers remaining`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Subscription not found' });
  }
});

// 4. Send push notification to a specific subscriber
app.post('/api/notify-one', (req, res) => {
  const { endpoint, title, body, urgency } = req.body;
  
  const subscription = subscriptions.get(endpoint);
  if (!subscription) {
    return res.status(404).json({ error: 'Subscription not found' });
  }

  const payload = JSON.stringify({
    title: title || 'Reminder',
    body: body || 'You have a scheduled event',
    urgency: urgency || 'mild',
    icon: '/assets/icons/icon-192x192.png'
  });

  webpush
    .sendNotification(subscription, payload)
    .then(() => {
      console.log('✓ Notification sent');
      res.json({ success: true });
    })
    .catch(err => {
      console.error('Push error:', err.message);
      
      // If subscription is invalid, remove it
      if (err.statusCode === 410) {
        subscriptions.delete(endpoint);
      }
      
      res.status(500).json({ error: err.message });
    });
});

// 5. Send push notification to all subscribers
app.post('/api/notify-all', (req, res) => {
  const { title, body, urgency } = req.body;
  
  if (subscriptions.size === 0) {
    return res.json({ success: true, sent: 0, message: 'No subscribers' });
  }

  const payload = JSON.stringify({
    title: title || 'Reminder',
    body: body || 'You have a scheduled event',
    urgency: urgency || 'mild',
    icon: '/assets/icons/icon-192x192.png'
  });

  let sent = 0;
  let failed = 0;

  subscriptions.forEach((subscription, endpoint) => {
    webpush
      .sendNotification(subscription, payload)
      .then(() => {
        sent++;
      })
      .catch(err => {
        failed++;
        console.error(`Failed to send to ${endpoint}:`, err.message);
        
        // Remove invalid subscriptions
        if (err.statusCode === 410) {
          subscriptions.delete(endpoint);
        }
      });
  });

  res.json({ success: true, sent, failed });
});

// 6. Get subscriber count
app.get('/api/subscribers-count', (req, res) => {
  res.json({ count: subscriptions.size });
});

// 7. Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    subscribers: subscriptions.size,
    scheduled: scheduledEvents.size,
    timestamp: new Date().toISOString()
  });
});

// 8. Add scheduled event notification
app.post('/api/schedule-event', (req, res) => {
  const { eventId, title, category, eventDate, notifTime, notifDays, notifUrgency, timezoneOffset } = req.body;
  
  if (!eventId || !eventDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  scheduledEvents.set(eventId, {
    eventId,
    title,
    category,
    eventDate,
    notifTime,
    notifDays,
    notifUrgency,
    timezoneOffset,
    createdAt: new Date()
  });

  console.log(`✓ Event scheduled: "${title}" on ${eventDate}`);
  res.json({ success: true });
});

// 9. Remove scheduled event
app.post('/api/unschedule-event', (req, res) => {
  const { eventId } = req.body;
  
  if (scheduledEvents.has(eventId)) {
    scheduledEvents.delete(eventId);
    console.log(`✓ Event unscheduled: ${eventId}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Event not found' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log('\n🚀 Ale\'s Calendar Server Running');
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`✓ VAPID keys configured`);
  console.log(`✓ Waiting for subscriptions...\n`);
});

// ===== NOTIFICATION SCHEDULER =====
// Check every minute for events that should trigger notifications
setInterval(() => {
  const now = new Date();
  const sentToday = new Set();

  scheduledEvents.forEach((event, eventId) => {
    try {
      // Adjust to client's timezone (offset in minutes; Date.getTimezoneOffset is minutes behind UTC)
      const tzOffset = event.timezoneOffset ?? 0;
      const clientNow = new Date(now.getTime() - tzOffset * 60_000);

      // Parse event date (assumed local to client)
      const [year, month, day] = event.eventDate.split('-').map(Number);
      const eventDate = new Date(year, month - 1, day);
      
      // Calculate notification date (subtract days before)
      const notifDate = new Date(eventDate);
      notifDate.setDate(notifDate.getDate() - (event.notifDays || 0));
      
      // Check if today is the notification day in client's local time
      const isNotifDay = 
        clientNow.getFullYear() === notifDate.getFullYear() &&
        clientNow.getMonth() === notifDate.getMonth() &&
        clientNow.getDate() === notifDate.getDate();
      
      if (!isNotifDay) return;
      
      // Check if time matches (if specified) using client's local time
      if (event.notifTime) {
        const [hours, minutes] = event.notifTime.split(':').map(Number);
        const isRightTime = clientNow.getHours() === hours && clientNow.getMinutes() === minutes;
        if (!isRightTime) return;
      }
      
      // Rate limit: send only once per client day
      const key = `${eventId}_${ymd(clientNow)}`;
      if (sentToday.has(key)) return;
      sentToday.add(key);
      
      // Calculate days until event in client's local date
      const startOfTodayClient = new Date(clientNow.getFullYear(), clientNow.getMonth(), clientNow.getDate());
      const daysUntil = Math.floor((eventDate - startOfTodayClient) / (1000 * 60 * 60 * 24));
      
      // Prepare notification
      const categoryEmojis = { work: '💼', school: '📚', personal: '💝' };
      const emoji = categoryEmojis[event.category] || '💝';
      
      let body = '';
      if (daysUntil === 0) {
        body = `Today: ${emoji} ${event.title}`;
      } else {
        body = `In ${daysUntil} day${daysUntil === 1 ? '' : 's'}: ${emoji} ${event.title}`;
      }
      
      // Send to all subscribers
      if (subscriptions.size > 0) {
        sendToAllSubscribers({
          title: 'Reminder 💚',
          body,
          urgency: event.notifUrgency || 'mild'
        });
        
        console.log(`📤 Sent notification: "${body}"`);
      }
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  });
}, 60_000); // Check every minute

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sendToAllSubscribers(notification) {
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    urgency: notification.urgency,
    icon: '/assets/icons/icon-192x192.png'
  });

  subscriptions.forEach((subscription, endpoint) => {
    webpush
      .sendNotification(subscription, payload)
      .catch(err => {
        if (err.statusCode === 410) {
          subscriptions.delete(endpoint);
        }
      });
  });
}
