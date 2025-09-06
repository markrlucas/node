const express = require('express');
const path = require('path');
const app = express();


// Serve all static files in public and its subdirectories
app.use(express.static(path.join(__dirname, 'public')));

// Optionally, keep includes route if needed
app.use('/includes', express.static(path.join(__dirname, 'includes')));


// Serve graphs-COB.html for root if it exists, otherwise send a default message
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'graphs-COB.html');
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
