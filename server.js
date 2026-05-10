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

app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));
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
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const cookieString = convertToCookieString(cookie);
    
    if (!cookieString) {
      return res.status(400).json({ error: 'Invalid cookie format. Please check your input.' });
    }

    if (!cookieString.includes('c_user') || !cookieString.includes('xs')) {
      return res.status(400).json({ error: 'Cookie missing required fields: c_user and xs' });
    }

    const result = await startShareSession(cookieString, url, parseInt(amount), parseInt(interval));
    
    res.status(200).json({ 
      status: 200, 
      message: result.message || 'Share session started successfully.',
      details: { url, amount, interval }
    });

  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: err.message || 'Server Error' });
  }
});

// Convert any cookie format to string
function convertToCookieString(cookieInput) {
  // 1. Check if it's already a valid cookie string
  if (typeof cookieInput === 'string') {
    if (cookieInput.includes('=') && (cookieInput.includes('c_user') || cookieInput.includes('xs'))) {
      return cookieInput;
    }
    
    // 2. Try to parse as JSON (Appstate format with name/value)
    if (cookieInput.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(cookieInput);
        if (Array.isArray(parsed)) {
          const cookieParts = [];
          for (const item of parsed) {
            const key = item.key || item.name;
            const value = item.value;
            if (key && value && (key === 'c_user' || key === 'xs' || key === 'datr' || key === 'sb' || key === 'fr')) {
              cookieParts.push(`${key}=${value}`);
            }
          }
          if (cookieParts.length > 0 && cookieParts.some(p => p.startsWith('c_user=')) && cookieParts.some(p => p.startsWith('xs='))) {
            return cookieParts.join('; ');
          }
        }
      } catch (e) {
        // Not valid JSON
      }
    }
    
    // 3. Parse Netscape format (tab-separated)
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
      
      if (cookieParts.length > 0 && cookieParts.some(p => p.startsWith('c_user=')) && cookieParts.some(p => p.startsWith('xs='))) {
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
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // Send shares with delays
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
      
      // Wait for interval before next share (except after last)
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
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'cookie': cookieString,
      'referer': 'https://www.facebook.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    const endpoints = [
      'https://business.facebook.com/content_management',
      'https://business.facebook.com/business_locations',
      'https://business.facebook.com/settings'
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
              console.log('Access token retrieved successfully');
              return token;
            }
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Get access token error:', error.message);
    return null;
  }
}

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
