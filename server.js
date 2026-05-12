const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// 3 Server URLs (update with your actual server URLs)
const SERVER_URLS = {
  server1: process.env.SERVER1_URL || 'https://server1-project502.onrender.com',
  server2: process.env.SERVER2_URL || 'https://server2-project502.onrender.com',
  server3: process.env.SERVER3_URL || 'https://server3-project502.onrender.com'
};

// Allowed origins for CORS
const allowedOrigin = [
  "https://fbshareselov.vercel.app",
  "https://alltools.vercel.app"
];

app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get server status
app.get('/api/servers/status', async (req, res) => {
  const serverStatus = {};
  
  for (const [key, url] of Object.entries(SERVER_URLS)) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${url}/api/health`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }
      });
      
      clearTimeout(timeoutId);
      
      serverStatus[key] = {
        url: url,
        status: response.ok ? 'active' : 'offline',
        online: response.ok
      };
    } catch (error) {
      serverStatus[key] = {
        url: url,
        status: 'offline',
        online: false,
        error: error.message
      };
    }
  }
  
  res.json({ servers: serverStatus });
});

// Main submit endpoint - forwards to selected server
app.post('/api/submit', async (req, res) => {
  const origin = req.headers.origin;
  if (!allowedOrigin.includes(origin)) {
    return res.status(400).json({ error: 'Invalid origin' });
  }

  const { cookie, url, amount, interval, server } = req.body;

  if (!cookie || !url || !amount || !interval) {
    return res.status(400).json({ error: 'Missing required fields: cookie, url, amount, or interval' });
  }

  if (!server || !SERVER_URLS[server]) {
    return res.status(400).json({ error: 'Invalid or no server selected. Please choose Server 1, 2, or 3.' });
  }

  const selectedServerUrl = SERVER_URLS[server];

  try {
    // Forward request to selected server
    const response = await axios.post(`${selectedServerUrl}/api/share`, {
      cookie: cookie,
      url: url,
      amount: parseInt(amount),
      interval: parseInt(interval)
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': req.ip
      },
      timeout: 30000
    });

    res.status(200).json({
      status: 200,
      message: response.data.message || 'Share session started successfully on ' + server,
      server: server,
      serverUrl: selectedServerUrl,
      details: { url, amount, interval }
    });

  } catch (error) {
    console.error('Submit error:', error.message);
    
    let errorMessage = 'Failed to start share session. ';
    if (error.code === 'ECONNREFUSED') {
      errorMessage += 'Server is offline. Please try another server.';
    } else if (error.response) {
      errorMessage += error.response.data?.error || `Server returned status ${error.response.status}`;
    } else if (error.request) {
      errorMessage += 'No response from server. It may be down.';
    } else {
      errorMessage += error.message;
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

// Health check endpoint for this server
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    servers: Object.keys(SERVER_URLS)
  });
});

// Convert any cookie format to string
function convertToCookieString(cookieInput) {
  if (typeof cookieInput === 'string') {
    // Already a cookie string
    if (cookieInput.includes('=') && (cookieInput.includes('c_user') || cookieInput.includes('xs'))) {
      return cookieInput;
    }
    
    // Parse JSON array (Appstate format)
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
      } catch (e) {}
    }
    
    // Parse Netscape format
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

async function startShareSession(cookieString, url, amount, interval) {
  try {
    const postId = await getPostID(url);
    if (!postId) {
      throw new Error('Invalid URL: Could not extract post ID');
    }
    
    const accessToken = await getAccessToken(cookieString);
    if (!accessToken) {
      throw new Error('Failed to retrieve access token. Cookie may be invalid or expired.');
    }

    console.log(`Starting share session - Post: ${postId}, Shares: ${amount}, Interval: ${interval}s`);

    let sharedCount = 0;
    let errors = 0;

    const headers = {
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate',
      'connection': 'keep-alive',
      'cookie': cookieString,
      'host': 'graph.facebook.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    for (let i = 0; i < amount; i++) {
      try {
        const response = await axios.post(
          `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${postId}&published=0&access_token=${accessToken}`,
          {},
          { headers: headers, timeout: 10000 }
        );

        if (response.status === 200) {
          sharedCount++;
          console.log(`Share ${sharedCount}/${amount} successful`);
        }
      } catch (error) {
        errors++;
        console.error(`Share ${i+1} failed: ${error.message}`);
      }
      
      if (i < amount - 1) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
      }
    }

    return { 
      success: true, 
      message: `Completed ${sharedCount}/${amount} shares. ${errors} failed.`,
      sharedCount,
      errors
    };

  } catch (error) {
    throw new Error(`Share session failed: ${error.message}`);
  }
}

async function getPostID(url) {
  try {
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
  } catch (error) {}
  
  const patterns = [
    /story_fbid=(\d+)/,
    /fbid=(\d+)/,
    /\/posts\/(\d+)/,
    /\/photo\.php\?fbid=(\d+)/,
    /\/pfbid0?(\d+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  const numbers = url.match(/\d{10,}/g);
  if (numbers && numbers[0]) {
    return numbers[0];
  }
  
  return null;
}

async function getAccessToken(cookieString) {
  try {
    const headers = {
      'authority': 'business.facebook.com',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      'cookie': cookieString,
      'referer': 'https://www.facebook.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    const endpoints = [
      'https://business.facebook.com/content_management',
      'https://business.facebook.com/business_locations'
    ];
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(endpoint, { headers: headers, timeout: 15000 });
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
              return token;
            }
          }
        }
      } catch (e) {}
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`   SELOV SHAREBOOSTER - MAIN SERVER`);
  console.log(`========================================`);
  console.log(`   Port: ${PORT}`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`========================================`);
  console.log(`   Configured Servers:`);
  for (const [key, url] of Object.entries(SERVER_URLS)) {
    console.log(`   ${key}: ${url}`);
  }
  console.log(`========================================`);
});
