import type { BrowserDirectoryHandle } from './types.ts';

const DATABASE = 'yeyu-course-handles';
const STORE = 'courses';

export interface RecentCourse {
  id: string;
  name: string;
  handle: BrowserDirectoryHandle;
  updatedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRecentCourse(course: RecentCourse): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(course);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadRecentCourses(): Promise<RecentCourse[]> {
  if (typeof indexedDB === 'undefined') return [];
  const database = await openDatabase();
  const result = await new Promise<RecentCourse[]>((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as RecentCourse[]);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
