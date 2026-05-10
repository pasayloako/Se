const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigin = [
  "https://fbshareselov.vercel.app",
  "https://alltools.vercel.app"
];

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
    return res.status(400).json({ error: 'Invalid origin' });
  }

  const { cookie, url, amount, interval } = req.body;

  if (!cookie || !url || !amount || !interval) {
    return res.status(400).json({ error: 'Missing required fields: cookie, url, amount, or interval' });
  }

  try {
    // Convert any format to cookie string
    const cookieString = await convertToCookieString(cookie);
    
    if (!cookieString) {
      return res.status(400).json({ error: 'Invalid cookie format. Could not extract valid cookies.' });
    }

    // Validate cookie has required fields
    if (!cookieString.includes('c_user') || !cookieString.includes('xs')) {
      return res.status(400).json({ error: 'Cookie missing required fields: c_user and xs' });
    }

    // Start share session asynchronously
    startShareSession(cookieString, url, parseInt(amount), parseInt(interval));
    
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
    console.error('Submit error:', err.message);
    res.status(500).json({ status: 500, error: err.message || 'Server Error' });
  }
});

// Convert any cookie format to string
async function convertToCookieString(cookieInput) {
  // 1. Check if it's already a valid cookie string
  if (typeof cookieInput === 'string') {
    // Check if it's a valid cookie string format
    if (cookieInput.includes('=') && (cookieInput.includes('c_user') || cookieInput.includes('xs'))) {
      // Already a cookie string
      return cookieInput;
    }
    
    // 2. Try to parse as JSON (Appstate format)
    if (cookieInput.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(cookieInput);
        if (Array.isArray(parsed)) {
          const cookieParts = [];
          for (const item of parsed) {
            const key = item.key || item.name;
            const value = item.value;
            if (key && value) {
              cookieParts.push(`${key}=${value}`);
            }
          }
          if (cookieParts.length > 0) {
            return cookieParts.join('; ');
          }
        }
      } catch (e) {
        // Not valid JSON, continue to next format
      }
    }
    
    // 3. Parse Netscape format
    if (cookieInput.includes('# Netscape') || (cookieInput.includes('\t') && cookieInput.includes('facebook.com'))) {
      const cookieParts = [];
      const lines = cookieInput.split('\n');
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#') || trimmedLine === '') continue;
        
        const parts = trimmedLine.split('\t');
        if (parts.length >= 7) {
          const domain = parts[0];
          const name = parts[5];
          const value = parts[6];
          
          // Only take Facebook cookies
          if (domain.includes('facebook.com') && name && value) {
            cookieParts.push(`${name}=${value}`);
          }
        }
      }
      
      if (cookieParts.length > 0) {
        return cookieParts.join('; ');
      }
    }
  }
  
  return null;
}

// Track active sessions
let activeSessions = new Map();

async function startShareSession(cookieString, url, amount, interval) {
  const sessionId = Date.now().toString();
  
  try {
    const postId = await getPostID(url);
    const accessToken = await getAccessToken(cookieString);

    if (!postId) {
      console.error(`[ERROR] Invalid URL: Could not extract post ID from ${url}`);
      return;
    }
    
    if (!accessToken) {
      console.error(`[ERROR] Failed to retrieve access token. Cookie may be invalid or expired.`);
      return;
    }

    console.log(`[SESSION ${sessionId}] Started - Post: ${postId}, Shares: ${amount}, Interval: ${interval}s`);

    let sharedCount = 0;
    
    activeSessions.set(sessionId, {
      sharedCount: 0,
      total: amount,
      startTime: new Date(),
      postId: postId
    });

    const headers = {
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate',
      'connection': 'keep-alive',
      'cookie': cookieString,
      'host': 'graph.facebook.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    const timer = setInterval(async () => {
      try {
        const response = await axios.post(
          `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${postId}&published=0&access_token=${accessToken}`,
          {},
          { headers: headers }
        );

        if (response.status === 200) {
          sharedCount++;
          const session = activeSessions.get(sessionId);
          if (session) {
            session.sharedCount = sharedCount;
          }
          console.log(`[SESSION ${sessionId}] Progress: ${sharedCount}/${amount} - Share successful`);
        }

        if (sharedCount >= amount) {
          clearInterval(timer);
          activeSessions.delete(sessionId);
          console.log(`[SESSION ${sessionId}] Completed: ${sharedCount}/${amount} shares for post ${postId}`);
        }
      } catch (error) {
        console.error(`[SESSION ${sessionId}] Error: ${error.message}`);
        // Don't stop on single error, continue trying
      }
    }, interval * 1000);

    // Safety timeout to clean up
    setTimeout(() => {
      if (activeSessions.has(sessionId)) {
        clearInterval(timer);
        activeSessions.delete(sessionId);
        console.log(`[SESSION ${sessionId}] Stopped by safety timeout`);
      }
    }, amount * interval * 1000 + 30000);

  } catch (error) {
    console.error(`[SESSION ${sessionId}] Fatal error: ${error.message}`);
    activeSessions.delete(sessionId);
  }
}

// Get post ID from URL
async function getPostID(url) {
  try {
    // Try external API first
    const response = await axios.post('https://id.traodoisub.com/api.php', 
      `link=${encodeURIComponent(url)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );
    
    if (response.data && response.data.id) {
      return response.data.id;
    }
  } catch (error) {
    console.log('External API failed, trying local extraction...');
  }
  
  // Local extraction fallback
  const patterns = [
    /story_fbid=(\d+)/,
    /fbid=(\d+)/,
    /\/posts\/(\d+)/,
    /\/photo\.php\?fbid=(\d+)/,
    /\/pfbid0?(\d+)/,
    /\/reel\/(\d+)/,
    /\/watch\/\?v=(\d+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // Try to extract any large number from URL as last resort
  const numbers = url.match(/\d{10,}/g);
  if (numbers && numbers[0]) {
    return numbers[0];
  }
  
  return null;
}

// Get access token from cookie
async function getAccessToken(cookieString) {
  try {
    const headers = {
      'authority': 'business.facebook.com',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'max-age=0',
      'cookie': cookieString,
      'referer': 'https://www.facebook.com/',
      'sec-ch-ua': '"Chromium";v="120", "Not:A-Brand";v="24", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // Try multiple endpoints
    const endpoints = [
      'https://business.facebook.com/content_management',
      'https://business.facebook.com/business_locations',
      'https://business.facebook.com/settings'
    ];
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(endpoint, { headers: headers, timeout: 15000 });
        
        // Try different token patterns
        const patterns = [
          /"accessToken":"([^"]+)"/,
          /"access_token":"([^"]+)"/,
          /EAAG\w+/,
          /EAAAA\w+/
        ];
        
        for (const pattern of patterns) {
          const match = response.data.match(pattern);
          if (match) {
            const token = match[1] || match[0];
            if (token && (token.startsWith('EAAG') || token.startsWith('EAAAA'))) {
              console.log('Access token retrieved successfully');
              return token;
            }
          }
        }
      } catch (e) {
        console.log(`Failed on endpoint ${endpoint}: ${e.message}`);
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Get access token error:', error.message);
    return null;
  }
}

// Status endpoint to check active sessions
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  if (session) {
    res.json({
      active: true,
      sharedCount: session.sharedCount,
      total: session.total,
      progress: (session.sharedCount / session.total) * 100,
      postId: session.postId
    });
  } else {
    res.json({ active: false });
  }
});

// Get all active sessions
app.get('/api/sessions', (req, res) => {
  const sessions = [];
  for (const [id, data] of activeSessions) {
    sessions.push({
      sessionId: id,
      sharedCount: data.sharedCount,
      total: data.total,
      progress: (data.sharedCount / data.total) * 100,
      postId: data.postId,
      startTime: data.startTime
    });
  }
  res.json({ sessions });
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`   SELOV FB SHARE BOT SERVER RUNNING`);
  console.log(`========================================`);
  console.log(`   Port: ${PORT}`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`========================================`);
  console.log(`   Supported Formats:`);
  console.log(`   📦 Appstate JSON`);
  console.log(`   🍪 Cookie String`);
  console.log(`   🌐 Netscape Format`);
  console.log(`========================================`);
});
