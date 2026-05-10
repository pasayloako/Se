const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigin = ["https://fb-sharer-by-bogart.vercel.app", "https://lalat.vercel.app", "http://localhost:3000", "http://localhost:5000"];

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/submit', async (req, res) => {
  const origin = req.headers.origin;
  if (!allowedOrigin.includes(origin)) {
    return res.status(400).send('Invalid origin');
  }

  const { cookie, url, amount, interval } = req.body;

  if (!cookie || !url || !amount || !interval) {
    return res.status(400).json({ error: 'Missing required fields: cookie, url, amount, or interval' });
  }

  try {
    const cookies = await convertCookie(cookie);
    if (!cookies) return res.status(400).json({ error: 'Invalid cookies format' });

    // Start share session asynchronously
    startShareSession(cookies, url, parseInt(amount), parseInt(interval));
    
    res.status(200).json({ 
      status: 200, 
      message: 'Share session started successfully.',
      details: {
        url: url,
        amount: amount,
        interval: interval
      }
    });

  } catch (err) {
    res.status(500).json({ status: 500, error: err.message || 'Server Error' });
  }
});

// Get share status (optional endpoint to track progress)
let activeSessions = new Map();

app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  if (session) {
    res.json({
      active: true,
      sharedCount: session.sharedCount,
      total: session.total,
      progress: (session.sharedCount / session.total) * 100
    });
  } else {
    res.json({ active: false });
  }
});

async function startShareSession(cookies, url, amount, interval) {
  const id = await getPostID(url);
  const accessToken = await getAccessToken(cookies);

  if (!id) throw new Error('Invalid URL: Post may be private or visible to friends only.');
  if (!accessToken) throw new Error('Failed to retrieve access token. Check cookies.');

  let sharedCount = 0;
  const sessionId = Date.now().toString();
  
  activeSessions.set(sessionId, {
    sharedCount: 0,
    total: amount,
    startTime: new Date()
  });

  const headers = {
    accept: '*/*',
    'accept-encoding': 'gzip, deflate',
    connection: 'keep-alive',
    cookie: cookies,
    host: 'graph.facebook.com',
  };

  const timer = setInterval(async () => {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
        {}, { headers }
      );

      if (response.status === 200) {
        sharedCount++;
        const session = activeSessions.get(sessionId);
        if (session) {
          session.sharedCount = sharedCount;
        }
        console.log(`[SHARE] Progress: ${sharedCount}/${amount} - Post ID: ${id}`);
      }

      if (sharedCount >= amount) {
        clearInterval(timer);
        activeSessions.delete(sessionId);
        console.log(`[SHARE] Completed: ${sharedCount}/${amount} shares for post ${id}`);
      }
    } catch (error) {
      console.error(`[SHARE] Error: ${error.message}`);
      clearInterval(timer);
      activeSessions.delete(sessionId);
    }
  }, interval * 1000);

  // Safety timeout
  setTimeout(() => {
    clearInterval(timer);
    activeSessions.delete(sessionId);
  }, amount * interval * 1000 + 5000);
}

async function convertCookie(cookie) {
  try {
    // Check if it's already a cookie string
    if (typeof cookie === 'string' && cookie.includes('=') && (cookie.includes(';') || cookie.includes('c_user'))) {
      // Validate it has required cookies
      if (cookie.includes('c_user') && cookie.includes('xs')) {
        return cookie;
      }
    }
    
    // Try to parse as JSON array (appstate format)
    const cookies = JSON.parse(cookie);
    if (Array.isArray(cookies)) {
      const sb = cookies.find(c => c.key === 'sb' || c.name === 'sb');
      if (!sb) throw new Error('Missing "sb" cookie in appstate.');
      return cookies.map(c => `${c.key || c.name}=${c.value}`).join('; ');
    }
    
    throw new Error('Invalid cookie format');
  } catch (e) {
    // If it's already a valid cookie string, return as is
    if (typeof cookie === 'string' && cookie.includes('c_user=')) {
      return cookie;
    }
    throw new Error('Invalid appstate format. Make sure it\'s a valid JSON array or cookie string.');
  }
}

async function getPostID(url) {
  try {
    const response = await axios.post('https://id.traodoisub.com/api.php', `link=${encodeURIComponent(url)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data.id;
  } catch {
    // Try to extract ID from URL directly
    const match = url.match(/[\?&]story_fbid=(\d+)/) || url.match(/\/posts\/(\d+)/) || url.match(/\/photo\.php\?fbid=(\d+)/);
    if (match) {
      return match[1];
    }
    return null;
  }
}

async function getAccessToken(cookie) {
  try {
    const headers = {
      authority: 'business.facebook.com',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      cookie: cookie,
      referer: 'https://www.facebook.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    const response = await axios.get('https://business.facebook.com/content_management', { headers });
    const tokenMatch = response.data.match(/"accessToken"\s*:\s*"([^"]+)"/);
    return tokenMatch ? tokenMatch[1] : null;
  } catch (error) {
    console.error('Failed to get access token:', error.message);
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
  console.log(`FB Share Bot is ready!`);
});
