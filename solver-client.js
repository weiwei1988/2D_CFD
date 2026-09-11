(function(global) {
  'use strict';
  class CFDWorkerClient {
    constructor(onError) {
      this.worker = new Worker('solver-worker.js?v=background-20260912-1');
      this.pending = new Map();
      this.nextId = 0;
      this.failure = null;
      this.onError = onError;
      this.worker.onmessage = ({data}) => {
        if (data.type === 'error') { this.fail(new Error(data.error)); return; }
        const request = this.pending.get(data.id);
        if (!request) return;
        this.pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data);
      };
      this.worker.onerror = event => { event.preventDefault(); this.fail(new Error(event.message || 'Worker failed')); };
      this.worker.onmessageerror = () => this.fail(new Error('Worker message could not be decoded'));
    }
    request(type, payload = {}) {
      if (this.failure) return Promise.reject(this.failure);
      const id = ++this.nextId;
      return new Promise((resolve, reject) => {
        this.pending.set(id, {resolve, reject});
        try { this.worker.postMessage({...payload, id, type}); }
        catch (error) { this.pending.delete(id); reject(error); }
      });
    }
    fail(error) {
      if (this.failure) return;
      this.failure = error;
      this.worker.terminate();
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.onError?.(error);
    }
  }
  global.CFDWorkerClient = CFDWorkerClient;
})(globalThis);
