const _ = require('lodash');

class TaskQueue {

  constructor() {
    this.queue = [];
    this.running = false;
    this.executeNext = this.executeNext.bind(this);
    this.enqueue = this.enqueue.bind(this);
    this.enqueueIn = this.enqueueIn.bind(this);
  }

  executeNext() {
    if (!this.running) {
      this.running = true;
      const task = this.queue.shift();
      if (task) {
        try {
          const promise = task();
          if (!promise) {
            this.running = false;
            setTimeout(() => this.executeNext());
          } else {
            if (promise.then && _.isFunction(promise.then)) {
              promise.then(r => {
                this.running = false;
                setTimeout(() => this.executeNext());
              }, e => {
                console.log('Error while running async task', e);
                this.running = false;
                setTimeout(() => this.executeNext());
              }).catch(e => {
                console.log('Error while running async task', e);
                this.running = false;
                setTimeout(() => this.executeNext());
              });
            } else {
              this.running = false;
              setTimeout(() => this.executeNext());
            }
          }
        } catch(e) {
          console.log('Error while running task', e);
          this.running = false;
          setTimeout(() => this.executeNext());
        }
      } else {
        this.running = false;
        setTimeout(() => this.executeNext(), 100);
      }
    }
  }

  enqueue(task) {
    this.queue.push(task);
  }

  enqueueIn(millis) {
    return (task) => {
      setTimeout(() => {
        this.queue.push(task);
      }, millis);
    };
  }
}

exports.TaskQueue = TaskQueue;