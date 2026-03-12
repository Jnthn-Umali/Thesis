import 'dotenv/config';
import { createApp } from './app.js';
import { connectToDatabase } from './db/connection.js';

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Thesis';

async function start() {
  await connectToDatabase(MONGO_URI);
  const app = createApp();
  app.listen(PORT, () => console.log(`Auth API listening on http://0.0.0.0:${PORT}`));
}

start().catch((e) => {
  console.error('Failed to start server', e);
  process.exit(1);
});


