const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
} else {
  console.log(`API key loaded: ${API_KEY.substring(0, 12)}... (${API_KEY.length} chars)`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the HTML tool
  if (req.method === 'GET' && (req.url === '/' || req.url === '/lab-classifier.html')) {
    const file = req.url === '/lab-classifier-trimmed.html' ? 'lab-classifier-trimmed.html' : 'lab-classifier.html';
    try {
      const html = fs.readFileSync(path.join(__dirname, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Could not load ' + file);
    }
    return;
  }

  // Serve trimmed file
  if (req.method === 'GET' && req.url === '/trimmed') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'lab-classifier-trimmed.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Could not load lab-classifier-trimmed.html');
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      api_key_set: !!API_KEY,
      api_key_prefix: API_KEY ? API_KEY.substring(0, 12) + '...' : 'NOT SET'
    }));
    return;
  }

  // Proxy API calls to Anthropic
  if (req.method === 'POST' && req.url === '/api') {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY is not configured on the server.' } }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 300000  // 5 minutes — web search calls can take a long time
      };

      // Start streaming response immediately so Railway's LB doesn't time out.
      // We use Transfer-Encoding: chunked and send the Anthropic response as it arrives.
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'   // tells Railway/nginx not to buffer this response
      });

      // Send a comment byte every 15s so Railway's load balancer sees activity
      // We'll prepend harmless whitespace that JSON.parse ignores
      let keepAliveInterval = setInterval(() => {
        try { res.write(' '); } catch(_) {}
      }, 15000);

      const apiReq = https.request(options, apiRes => {
        clearInterval(keepAliveInterval);

        if (apiRes.statusCode !== 200) {
          let errData = '';
          apiRes.on('data', chunk => errData += chunk);
          apiRes.on('end', () => {
            console.error(`Anthropic returned ${apiRes.statusCode}:`, errData.substring(0, 300));
            // We've already written 200 headers — send the error body as JSON
            // The client checks response.ok via status, but since we're chunking
            // we embed the status in a wrapper the client can detect
            res.end(errData);
          });
          return;
        }

        // Stream Anthropic's response back chunk by chunk
        apiRes.on('data', chunk => {
          try { res.write(chunk); } catch(_) {}
        });
        apiRes.on('end', () => {
          try { res.end(); } catch(_) {}
        });
        apiRes.on('error', e => {
          console.error('Anthropic stream error:', e.message);
          try { res.end(); } catch(_) {}
        });
      });

      apiReq.on('timeout', () => {
        clearInterval(keepAliveInterval);
        console.error('Anthropic request timed out after 5 minutes');
        apiReq.destroy();
        try { res.end(JSON.stringify({ error: { message: 'Request timed out after 5 minutes.' } })); } catch(_) {}
      });

      apiReq.on('error', e => {
        clearInterval(keepAliveInterval);
        console.error('Anthropic request error:', e.message);
        try { res.end(JSON.stringify({ error: { message: 'API request failed: ' + e.message } })); } catch(_) {}
      });

      apiReq.write(body);
      apiReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Disable Node's built-in socket timeout so Railway's LB controls the lifecycle
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, () => {
  console.log(`LabScope running at http://localhost:${PORT}`);
  console.log(`Trimmed version: http://localhost:${PORT}/trimmed`);
  console.log(`Health check:    http://localhost:${PORT}/health`);
});
