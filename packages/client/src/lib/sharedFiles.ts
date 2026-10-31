/**
 * Files handed to Beam through the OS share sheet (PWA share target).
 * public/sw.js parks them in IndexedDB; the send page takes them once.
 */
export async function takeSharedFiles(): Promise<File[]> {
  if (!('indexedDB' in window)) return [];
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('beam-share', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pending');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const files = await new Promise<File[]>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      const get = store.get('files');
      get.onsuccess = () => {
        store.delete('files');
        resolve((get.result as File[] | undefined) ?? []);
      };
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return files;
  } catch {
    return [];
  }
}
