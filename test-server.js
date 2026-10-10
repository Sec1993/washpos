require('http').createServer((req, res) => { res.writeHead(200); res.end('HELLO RAILWAY'); }).listen(3000, '0.0.0.0', () => console.log('BING BONG 3000'));
