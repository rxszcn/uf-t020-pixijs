import { Buffer } from '../../../shared/buffer/Buffer';
import { BufferUsage } from '../../../shared/buffer/const';
import { GpuBufferSystem } from '../GpuBufferSystem';

import type { GPU } from '../../GpuDeviceSystem';
import type { WebGPURenderer } from '../../WebGPURenderer';

// a minimal GPU device mock: created buffers are mappable, queue.writeBuffer is spied on
function createMockGpu()
{
    const gpu = {
        device: {
            createBuffer: jest.fn(() => ({
                getMappedRange: () => new ArrayBuffer(1024),
                unmap: jest.fn(),
                destroy: jest.fn(),
            })),
            queue: {
                writeBuffer: jest.fn(),
            },
        },
    };

    return gpu;
}

// a minimal renderer mock: GpuBufferSystem only needs a uid and the gc hooks
function createMockRenderer(uid: number)
{
    return {
        uid,
        gc: {
            now: 0,
            addResourceHash: jest.fn(),
        },
    } as unknown as WebGPURenderer;
}

function createBufferSystem(renderer: WebGPURenderer, gpu: ReturnType<typeof createMockGpu>)
{
    const system = new GpuBufferSystem(renderer) as GpuBufferSystem & { contextChange(gpu: GPU): void };

    system.contextChange(gpu as unknown as GPU);

    return system;
}

describe('GpuBufferSystem', () =>
{
    it('should upload an update to every renderer sharing the buffer', () =>
    {
        const gpu1 = createMockGpu();
        const gpu2 = createMockGpu();

        const system1 = createBufferSystem(createMockRenderer(1), gpu1);
        const system2 = createBufferSystem(createMockRenderer(2), gpu2);

        const buffer = new Buffer({
            data: new Float32Array([1, 2, 3, 4]),
            usage: BufferUsage.VERTEX,
        });

        // both renderers create their own GPU buffer for the shared Buffer
        system1.updateBuffer(buffer);
        system2.updateBuffer(buffer);

        expect(gpu1.device.createBuffer).toHaveBeenCalledTimes(1);
        expect(gpu2.device.createBuffer).toHaveBeenCalledTimes(1);

        buffer.update();

        // the update must land on both renderers, not just the first to consume it
        expect(gpu1.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
        expect(gpu2.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
    });

    it('should upload partial updates with size and offset to every renderer', () =>
    {
        const gpu1 = createMockGpu();
        const gpu2 = createMockGpu();

        const system1 = createBufferSystem(createMockRenderer(1), gpu1);
        const system2 = createBufferSystem(createMockRenderer(2), gpu2);

        const data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

        const buffer = new Buffer({
            data,
            usage: BufferUsage.VERTEX,
        });

        system1.updateBuffer(buffer);
        system2.updateBuffer(buffer);

        // partial update: 8 bytes (2 floats) at byte offset 8
        buffer.update(8, 8);

        for (const gpu of [gpu1, gpu2])
        {
            expect(gpu.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
            expect(gpu.device.queue.writeBuffer).toHaveBeenCalledWith(
                expect.anything(), // gpuBuffer
                8, // dest offset (bytes)
                data.buffer, // source ArrayBuffer
                data.byteOffset + 8, // source offset (bytes)
                8, // size, rounded to 4 bytes
            );
        }
    });

    it('should not replay stale updates on a renderer that creates the GPU buffer later', () =>
    {
        const gpu1 = createMockGpu();
        const gpu2 = createMockGpu();

        const system1 = createBufferSystem(createMockRenderer(1), gpu1);
        const system2 = createBufferSystem(createMockRenderer(2), gpu2);

        const buffer = new Buffer({
            data: new Float32Array([1, 2, 3, 4]),
            usage: BufferUsage.VERTEX,
        });

        system1.updateBuffer(buffer);

        // an update only renderer 1 is around to see
        buffer.update();

        expect(gpu1.device.queue.writeBuffer).toHaveBeenCalledTimes(1);

        // renderer 2 creates its GPU buffer now: the full data is copied at creation,
        // so the already-covered update must not be written again
        system2.updateBuffer(buffer);

        expect(gpu2.device.queue.writeBuffer).not.toHaveBeenCalled();

        // and the next update reaches both
        buffer.update();

        expect(gpu1.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
        expect(gpu2.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
    });

    it('should recreate the GPU buffer on every renderer when the buffer changes', () =>
    {
        const gpu1 = createMockGpu();
        const gpu2 = createMockGpu();

        const system1 = createBufferSystem(createMockRenderer(1), gpu1);
        const system2 = createBufferSystem(createMockRenderer(2), gpu2);

        const buffer = new Buffer({
            data: new Float32Array([1, 2, 3, 4]),
            usage: BufferUsage.VERTEX,
        });

        system1.updateBuffer(buffer);
        system2.updateBuffer(buffer);

        // resizing emits 'change', each renderer must recreate its own GPU buffer
        buffer.data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

        expect(gpu1.device.createBuffer).toHaveBeenCalledTimes(2);
        expect(gpu2.device.createBuffer).toHaveBeenCalledTimes(2);

        // updates after the change still reach both renderers
        buffer.update();

        expect(gpu1.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
        expect(gpu2.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
    });
});
