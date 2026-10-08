// Runs in the browser's audio thread: hands the microphone's samples to the page in
// blocks of 2048, so the page isn't woken for every 128-sample render quantum.

class EdithCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(2048)
    this.filled = 0
    // At the end of a recording the page asks for what is left in the block.
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      if (this.filled) this.port.postMessage(this.block.slice(0, this.filled))
      this.filled = 0
      this.port.postMessage('flushed')
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      let read = 0
      while (read < channel.length) {
        const take = Math.min(channel.length - read, this.block.length - this.filled)
        this.block.set(channel.subarray(read, read + take), this.filled)
        this.filled += take
        read += take
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice(0))
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('edith-capture', EdithCapture)
