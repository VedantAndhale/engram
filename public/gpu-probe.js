// Probe for the Gemma feature: reports the WebGPU buffer limits this device gives a page.
// Kept as an external file so the site's Content-Security-Policy (no inline scripts) still applies.

const MiB = 1024 * 1024;
const out = document.getElementById("out");
const lines = [];

function say(line) {
  lines.push(line);
  out.textContent = lines.join("\n");
}

// Create a buffer of `size` bytes and touch its end, so the device has to back it. Returns null
// when it worked, or the error text when it did not.
async function tryBuffer(device, size) {
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, size - 4, new Uint8Array(4));
  const oom = await device.popErrorScope();
  const validation = await device.popErrorScope();
  const error = oom ?? validation;
  buffer.destroy();
  await device.queue.onSubmittedWorkDone();
  return error ? error.message : null;
}

async function run() {
  lines.length = 0;
  say(`user agent: ${navigator.userAgent}`);
  if (!navigator.gpu) {
    say("navigator.gpu is missing: WebGPU is not available in this browser.");
    return;
  }
  const adapter = await navigator.gpu.requestAdapter().catch((err) => {
    say(`requestAdapter failed: ${err}`);
    return null;
  });
  if (!adapter) {
    say("No WebGPU adapter was found.");
    return;
  }
  const info = adapter.info ?? {};
  say(`adapter: vendor="${info.vendor ?? ""}" architecture="${info.architecture ?? ""}" device="${info.device ?? ""}" description="${info.description ?? ""}"`);
  const maxBuffer = adapter.limits.maxBufferSize;
  const maxBinding = adapter.limits.maxStorageBufferBindingSize;
  say(`adapter maxBufferSize: ${(maxBuffer / MiB).toFixed(0)} MiB`);
  say(`adapter maxStorageBufferBindingSize: ${(maxBinding / MiB).toFixed(0)} MiB`);

  const device = await adapter
    .requestDevice({ requiredLimits: { maxBufferSize: maxBuffer, maxStorageBufferBindingSize: maxBinding } })
    .catch((err) => {
      say(`requestDevice failed: ${err}`);
      return null;
    });
  if (!device) return;
  device.lost.then((event) => {
    if (event.reason !== "destroyed") say(`device lost: ${event.reason} ${event.message}`);
  });

  let largest = 0;
  for (const mib of [256, 512, 1024, 1536, 2048]) {
    const size = mib * MiB;
    if (size > maxBuffer) break;
    const error = await tryBuffer(device, size);
    say(`${mib} MiB buffer: ${error ? `failed (${error})` : "ok"}`);
    if (error) break;
    largest = size;
  }
  say(`largest buffer that worked: ${(largest / MiB).toFixed(0)} MiB`);
  device.destroy();
}

document.getElementById("run").addEventListener("click", () => {
  void run();
});
