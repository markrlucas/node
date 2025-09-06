const express = require('express');
const path = require('path');
const app = express();

const allowedPublicFiles = [
  'favicon.ico',
  'graphs-widgets.html',
  'graphs-COB.html',
  // add more allowed files here
];
const allowedIncludesFiles = [
  'WebSocketClient.js',
  'drawingTool.js',
  // add more allowed files here
];

app.get('/public/:filename', (req, res) => {
  const { filename } = req.params;
  if (allowedPublicFiles.includes(filename)) {
    res.sendFile(path.join(__dirname, 'public', filename));
  } else {
    res.status(403).send('Forbidden');
  }
});

app.get('/includes/:filename', (req, res) => {
  const { filename } = req.params;
  if (allowedIncludesFiles.includes(filename)) {
    res.sendFile(path.join(__dirname, 'includes', filename));
  } else {
    res.status(403).send('Forbidden');
  }
});


// Serve graphs-widgets.html for root if it exists, otherwise send a default message
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'graphs-widgets.html');
  res.sendFile(indexPath, err => {
    if (err) {
      res.send('Server is running!');
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
