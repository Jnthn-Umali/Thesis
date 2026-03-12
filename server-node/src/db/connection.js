import mongoose from 'mongoose';

let isConnected = false;

export async function connectToDatabase(uri) {
  if (isConnected) return mongoose.connection;
  await mongoose.connect(uri);
  isConnected = true;
  return mongoose.connection;
}


