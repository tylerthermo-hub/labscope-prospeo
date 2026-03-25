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
  // Keep the connection alive so long-running API calls don't time out
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=120');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the HTML tool
  if (req.method === 'GET' && req.url === '/') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'lab-classifier.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Could not load lab-classifier.html');
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

  // Proxy API calls to Anthropic — stream the response back to keep connection alive
  if (req.method === 'POST' && req.url === '/api') {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Server error: ANTHROPIC_API_KEY is not configured.' } }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      // Send periodic whitespace to Railway to prevent idle timeout
      // while we wait for Anthropic to respond
      let keepAliveInterval = setInterval(() => {
        try { req.socket.write(' '); } catch(_) {}
      }, 10000);

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
        timeout: 120000  // 2 minute socket timeout on the outbound request
      };

      const apiReq = https.request(options, apiRes => {
        clearInterval(keepAliveInterval);

        if (apiRes.statusCode !== 200) {
          let errData = '';
          apiRes.on('data', chunk => errData += chunk);
          apiRes.on('end', () => {
            console.error(`Anthropic API returned ${apiRes.statusCode}:`, errData.substring(0, 300));
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(errData);
          });
          return;
        }

        // Stream response chunks directly back to the browser as they arrive
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        });
        apiRes.on('data', chunk => res.write(chunk));
        apiRes.on('end', () => res.end());
        apiRes.on('error', e => {
          console.error('Anthropic stream error:', e.message);
          res.end();
        });
      });

      apiReq.on('timeout', () => {
        clearInterval(keepAliveInterval);
        console.error('Anthropic request timed out after 120s');
        apiReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request to Anthropic timed out after 120 seconds.' } }));
      });

      apiReq.on('error', e => {
        clearInterval(keepAliveInterval);
        console.error('Anthropic request error:', e.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Could not reach Anthropic API: ' + e.message } }));
        }
      });

      apiReq.write(body);
      apiReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// 2 minute server-level timeout — well above Railway's 60s default
server.timeout = 120000;
server.keepAliveTimeout = 120000;

server.listen(PORT, () => {
  console.log(`LabScope running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
