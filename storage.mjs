import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** A single-kitchen state repository. The application uses the same state shape in
 * development and production; only this adapter knows where it is stored. */
export async function openStore({ defaults, dataFile, env = process.env }) {
  let saveQueue = Promise.resolve();
  const enqueueSave = task => {
    const next = saveQueue.then(task, task);
    saveQueue = next.catch(() => {});
    return next;
  };
  if (env.MONGODB_URI) {
    let client;
    try {
      const { MongoClient } = await import('mongodb');
      client = new MongoClient(env.MONGODB_URI, {
        serverSelectionTimeoutMS: Number(env.MONGODB_CONNECT_TIMEOUT_MS) || 5000,
        maxPoolSize: Number(env.MONGODB_MAX_POOL_SIZE) || 10
      });
      await client.connect();
      const collection = client.db(env.MONGODB_DB || 'pantrypal').collection('app_state');
      await collection.createIndex({ key: 1 }, { unique: true });
      const document = await collection.findOne({ key: 'primary' });
      let initialState = document?.state;
      if (!initialState && existsSync(dataFile)) {
        try {
          initialState = JSON.parse(await readFile(dataFile, 'utf8'));
          await collection.updateOne({ key: 'primary' }, { $set: { state: initialState, updatedAt: new Date() } }, { upsert: true });
          console.info('Imported the existing local PantryPal state into MongoDB Atlas; the local file was kept as a backup.');
        } catch (error) {
          if (env.NODE_ENV === 'production') {
            const importError = new Error(`Existing local PantryPal data could not be imported (${error?.name || 'data error'}).`);
            importError.code = 'PANTRYPAL_DATA_IMPORT_FAILED';
            throw importError;
          }
          console.error(`Existing local PantryPal data could not be imported (${error?.name || 'data error'}); starting from an empty Atlas profile.`);
          initialState = undefined;
        }
      }
      return {
        mode: 'mongodb-atlas',
        state: initialState ? { ...defaults, ...initialState } : structuredClone(defaults),
        async save(state) {
          const snapshot = structuredClone(state);
          return enqueueSave(() => collection.updateOne({ key: 'primary' }, { $set: { state: snapshot, updatedAt: new Date() } }, { upsert: true }));
        },
        async close() { await saveQueue; await client.close(); }
      };
    } catch (error) {
      await client?.close().catch(() => {});
      if (env.NODE_ENV === 'production') {
        if (error?.code === 'PANTRYPAL_DATA_IMPORT_FAILED') throw error;
        throw new Error(`MongoDB is required in production but could not be reached (${error?.name || 'connection error'}).`);
      }
      console.error(`MongoDB connection failed in development (${error?.name || 'connection error'}); using local JSON persistence.`);
    }
  } else if (env.NODE_ENV === 'production') {
    throw new Error('MONGODB_URI must be configured in production.');
  }

  let localState = structuredClone(defaults);
  if (existsSync(dataFile)) {
    try { localState = { ...localState, ...JSON.parse(await readFile(dataFile, 'utf8')) }; }
    catch (error) { console.error(`Could not read local pantry data (${error?.name || 'file error'}); starting with an empty pantry.`); }
  }
  return {
    mode: 'local-json',
    state: localState,
    async save(state) {
      const snapshot = structuredClone(state);
      await mkdir(path.dirname(dataFile), { recursive: true });
      return enqueueSave(async () => {
        const temporary = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot, null, 2));
        await rename(temporary, dataFile);
      });
    },
    async close() {}
  };
}
