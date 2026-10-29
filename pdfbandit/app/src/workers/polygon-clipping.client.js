// Polygon Clipping Worker Client
// Provides a promise-based interface to the polygon-clipping Web Worker

class PolygonWorker {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.initPromise = this.init();
  }

  async init() {
    if (this.worker) return;
    
    // Create worker from inline script to avoid extra HTTP request
    const workerCode = `
      ${self.location.origin === 'file://' ? '' : ''}
      // Worker code will be inlined
    `;
    
    // Use the worker file
    this.worker = new Worker(new URL('./polygon-clipping.worker.js', import.meta.url), { 
      type: 'module',
      name: 'polygon-clipping'
    });
    
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      }
    };
    
    this.worker.onerror = (e) => {
      console.error('Polygon worker error:', e);
    };
    
    this.ready = true;
  }

  async call(type, payload) {
    await this.initPromise;
    const id = this.nextId++;
    
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Polygon worker timeout: ${type}`));
        }
      }, 30000);
    });
  }

  unionRings(rings) {
    return this.call('unionRings', { rings });
  }

  unionPolygons(a, b) {
    return this.call('unionPolygons', { a, b });
  }

  intersectPolygons(a, b) {
    return this.call('intersectPolygons', { a, b });
  }

  splitPolygonByLine(pts, A, B) {
    return this.call('splitPolygonByLine', { pts, A, B });
  }

  differencePolygons(a, b) {
    return this.call('differencePolygons', { a, b });
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }
}

// Singleton instance
let workerInstance = null;

export function getPolygonWorker() {
  if (!workerInstance) {
    workerInstance = new PolygonWorker();
  }
  return workerInstance;
}

// Re-export the synchronous functions that delegate to worker
export async function unionRings(list) {
  return getPolygonWorker().unionRings(list);
}

export async function unionPolygons(a, b) {
  return getPolygonWorker().unionPolygons(a, b);
}

export async function intersectPolygons(a, b) {
  return getPolygonWorker().intersectPolygons(a, b);
}

export async function splitPolygonByLine(pts, A, B) {
  return getPolygonWorker().splitPolygonByLine(pts, A, B);
}

export async function differencePolygons(a, b) {
  return getPolygonWorker().differencePolygons(a, b);
}