class Cache {
  constructor(initialValues = {}) {
    this.values = {};
    Object.keys(initialValues).map(k => [k, initialValues[k]]).map(kv => {
      const [key, value] = kv;
      this.values[key] = { timestamp: 0, value };
    });
    this.deleteTasks = [];
    this.counter = 0;
    this.get = this.get.bind(this);
    this.set = this.set.bind(this);
    this.delete = this.delete.bind(this);
    this.stop = this.stop.bind(this);
    this.popDeleteTask = this.popDeleteTask.bind(this);
    setTimeout(this.popDeleteTask, 10);
  }
  popDeleteTask() {
    try {
      while(this.deleteTasks.length > 0) {
        const { key, timestamp } = this.deleteTasks.pop();
        const value = this.values[key];
        if (value && value.timestamp === timestamp) {
          delete this.values[key];
        }
      }
    } catch(e) {
      console.error('Error while deleting', e);
    }
    this.timeout = setTimeout(this.popDeleteTask, 10);
  }
  get(key) {
    const value = this.values[key];
    if (value) {
      return value.value;
    } else {
      return null;
    }
  }
  set(key, value, ttl = 0) {
    this.counter = this.counter + 1;
    const timestamp = this.counter;
    this.values[key] = { timestamp, value };
    if (ttl > 0) {
      setTimeout(() => {
        this.deleteTasks.push({ timestamp, key });
      }, ttl);
    }
  }
  delete(key) {
    delete this.values[key];
  }
  stop() {
    this.popDeleteTask();
    clearTimeout(this.timeout);
  }
}

exports.Cache = Cache;