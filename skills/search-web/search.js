#!/usr/bin/env node
/**
 * search-web — Search the web using Perplexity AI API
 * Usage: search-web "your query"
 */

const https = require('https');
const { execSync } = require('child_process');

const query = process.argv.slice(2).join(' ');

if (!query) {
  console.error('Usage: search-web <query>');
  console.error('Example: search-web "latest AI news"');
  process.exit(1);
}

// Get API key from Key Vault
let API_KEY;
try {
  API_KEY = execSync('/iris/data/skills/get-secret/get-secret PERPLEXITY-API-KEY', {
    encoding: 'utf8'
  }).trim();
} catch (err) {
  console.error('Error: PERPLEXITY-API-KEY not found in Key Vault');
  console.error('Set it with: az keyvault secret set --vault-name <name> --name PERPLEXITY-API-KEY --value <key>');
  process.exit(1);
}

const payload = JSON.stringify({
  model: 'sonar-pro',
  messages: [
    {
      role: 'system',
      content: 'Be concise and factual. Include citations when relevant.'
    },
    {
      role: 'user',
      content: query
    }
  ],
  max_tokens: 1000,
  temperature: 0.2
});

const options = {
  hostname: 'api.perplexity.ai',
  path: '/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(body);
      
      if (json.error) {
        console.error(`API Error: ${json.error.message || json.error}`);
        process.exit(1);
      }

      const answer = json.choices?.[0]?.message?.content;
      if (!answer) {
        console.error('Error: No answer returned from API');
        process.exit(1);
      }

      console.log(answer);

      // Show citations if available
      const citations = json.citations;
      if (citations && citations.length > 0) {
        console.log('\nSources:');
        citations.forEach(url => console.log(`  • ${url}`));
      }
    } catch (e) {
      console.error('Parse error:', e.message);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
  process.exit(1);
});

req.write(payload);
req.end();
