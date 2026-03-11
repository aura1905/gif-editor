/**
 * Aseprite Encoder — .aseprite/.ase 바이너리 파일 생성기
 * Spec: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
 *
 * 지원 포맷: RGBA (32bpp), Compressed Cel (zlib)
 */

const AsepriteEncoder = (function () {
    'use strict';

    // ==============================
    // Binary Writer Helper
    // ==============================
    class BinaryWriter {
        constructor(initialSize = 65536) {
            this.buffer = new Uint8Array(initialSize);
            this.pos = 0;
        }

        ensureCapacity(needed) {
            while (this.pos + needed > this.buffer.length) {
                const newBuf = new Uint8Array(this.buffer.length * 2);
                newBuf.set(this.buffer);
                this.buffer = newBuf;
            }
        }

        writeByte(val) {
            this.ensureCapacity(1);
            this.buffer[this.pos++] = val & 0xff;
        }

        writeWord(val) {
            this.ensureCapacity(2);
            this.buffer[this.pos++] = val & 0xff;
            this.buffer[this.pos++] = (val >> 8) & 0xff;
        }

        writeShort(val) {
            this.writeWord(val & 0xffff);
        }

        writeDword(val) {
            this.ensureCapacity(4);
            this.buffer[this.pos++] = val & 0xff;
            this.buffer[this.pos++] = (val >> 8) & 0xff;
            this.buffer[this.pos++] = (val >> 16) & 0xff;
            this.buffer[this.pos++] = (val >> 24) & 0xff;
        }

        writeBytes(arr) {
            this.ensureCapacity(arr.length);
            this.buffer.set(arr, this.pos);
            this.pos += arr.length;
        }

        writeString(str) {
            const encoded = new TextEncoder().encode(str);
            this.writeWord(encoded.length);
            this.writeBytes(encoded);
        }

        writeZeros(count) {
            this.ensureCapacity(count);
            for (let i = 0; i < count; i++) {
                this.buffer[this.pos++] = 0;
            }
        }

        // Write value at specific position without moving pos
        writeDwordAt(pos, val) {
            this.buffer[pos] = val & 0xff;
            this.buffer[pos + 1] = (val >> 8) & 0xff;
            this.buffer[pos + 2] = (val >> 16) & 0xff;
            this.buffer[pos + 3] = (val >> 24) & 0xff;
        }

        writeWordAt(pos, val) {
            this.buffer[pos] = val & 0xff;
            this.buffer[pos + 1] = (val >> 8) & 0xff;
        }

        getResult() {
            return this.buffer.slice(0, this.pos);
        }
    }

    // ==============================
    // zlib compression using DeflateRaw
    // ==============================
    async function zlibCompress(data) {
        // Use CompressionStream with 'deflate' (zlib format = deflate with zlib wrapper)
        const stream = new Blob([data]).stream();
        const compressedStream = stream.pipeThrough(new CompressionStream('deflate'));
        const reader = compressedStream.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    // ==============================
    // Color helpers
    // ==============================
    function hexToRgb(hex) {
        hex = hex.replace('#', '');
        return {
            r: parseInt(hex.substring(0, 2), 16),
            g: parseInt(hex.substring(2, 4), 16),
            b: parseInt(hex.substring(4, 6), 16)
        };
    }

    // ==============================
    // Main Encoder
    // ==============================
    async function encode(options) {
        const { width, height, frames, delays, tags = [] } = options;
        const numFrames = frames.length;
        const w = new BinaryWriter(width * height * numFrames * 4 + 65536);

        // --- FILE HEADER (128 bytes) ---
        const headerStart = w.pos;
        w.writeDword(0);            // File size (fill later)
        w.writeWord(0xA5E0);        // Magic number
        w.writeWord(numFrames);     // Number of frames
        w.writeWord(width);         // Width
        w.writeWord(height);        // Height
        w.writeWord(32);            // Color depth: 32 = RGBA
        w.writeDword(1);            // Flags: layer opacity valid
        w.writeWord(100);           // Speed (deprecated, use frame duration)
        w.writeDword(0);            // Reserved
        w.writeDword(0);            // Reserved
        w.writeByte(0);             // Transparent color index (N/A for RGBA)
        w.writeZeros(3);            // Ignore
        w.writeWord(0);             // Number of colors (0 = not indexed)
        w.writeByte(1);             // Pixel width
        w.writeByte(1);             // Pixel height
        w.writeShort(0);            // Grid X
        w.writeShort(0);            // Grid Y
        w.writeWord(0);             // Grid width
        w.writeWord(0);             // Grid height
        w.writeZeros(84);           // Reserved
        // Header should be exactly 128 bytes

        // --- FRAMES ---
        for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            const frameStart = w.pos;
            const isFirstFrame = (frameIdx === 0);

            // Count chunks for this frame
            let chunkCount = 1; // Always has 1 cel chunk
            if (isFirstFrame) {
                chunkCount += 1; // Color Profile
                chunkCount += 1; // Layer
                chunkCount += 1; // Palette
                if (tags.length > 0) chunkCount += 1; // Tags
            }

            // Frame header (16 bytes)
            w.writeDword(0);            // Frame size (fill later)
            w.writeWord(0xF1FA);        // Magic
            w.writeWord(chunkCount < 0xFFFF ? chunkCount : 0xFFFF); // Old chunk count
            w.writeWord(delays[frameIdx] || 100); // Duration in ms
            w.writeZeros(2);            // Reserved
            w.writeDword(chunkCount);   // New chunk count

            if (isFirstFrame) {
                // --- Color Profile Chunk (0x2007) ---
                writeColorProfileChunk(w);

                // --- Layer Chunk (0x2004) ---
                writeLayerChunk(w);

                // --- Palette Chunk (0x2019) ---
                writePaletteChunk(w);

                // --- Tags Chunk (0x2018) ---
                if (tags.length > 0) {
                    writeTagsChunk(w, tags);
                }
            }

            // --- Cel Chunk (0x2005) ---
            await writeCelChunk(w, frames[frameIdx], width, height);

            // Fill in frame size
            const frameSize = w.pos - frameStart;
            w.writeDwordAt(frameStart, frameSize);
        }

        // Fill in file size
        w.writeDwordAt(headerStart, w.pos);

        return w.getResult();
    }

    // ==============================
    // Chunk Writers
    // ==============================
    function writeColorProfileChunk(w) {
        const chunkStart = w.pos;
        w.writeDword(0);        // Chunk size (fill later)
        w.writeWord(0x2007);    // Chunk type
        w.writeWord(1);         // Type: sRGB
        w.writeWord(0);         // Flags
        w.writeDword(0);        // Fixed gamma (unused for sRGB)
        w.writeZeros(8);        // Reserved
        w.writeDwordAt(chunkStart, w.pos - chunkStart);
    }

    function writeLayerChunk(w) {
        const chunkStart = w.pos;
        w.writeDword(0);        // Chunk size (fill later)
        w.writeWord(0x2004);    // Chunk type
        w.writeWord(1 | 2);     // Flags: Visible + Editable
        w.writeWord(0);         // Layer type: Normal
        w.writeWord(0);         // Child level
        w.writeWord(0);         // Default width (ignored)
        w.writeWord(0);         // Default height (ignored)
        w.writeWord(0);         // Blend mode: Normal
        w.writeByte(255);       // Opacity
        w.writeZeros(3);        // Reserved
        w.writeString('Layer 1');
        w.writeDwordAt(chunkStart, w.pos - chunkStart);
    }

    function writePaletteChunk(w) {
        // Write a minimal 256-color palette
        const numColors = 256;
        const chunkStart = w.pos;
        w.writeDword(0);            // Chunk size (fill later)
        w.writeWord(0x2019);        // Chunk type
        w.writeDword(numColors);    // Palette size
        w.writeDword(0);            // First color
        w.writeDword(numColors - 1);// Last color
        w.writeZeros(8);            // Reserved

        for (let i = 0; i < numColors; i++) {
            w.writeWord(0);         // Entry flags
            if (i === 0) {
                w.writeByte(0); w.writeByte(0); w.writeByte(0); w.writeByte(255); // Black
            } else if (i === 255) {
                w.writeByte(255); w.writeByte(255); w.writeByte(255); w.writeByte(255); // White
            } else {
                // Generate a simple spread
                w.writeByte(i); w.writeByte(i); w.writeByte(i); w.writeByte(255);
            }
        }
        w.writeDwordAt(chunkStart, w.pos - chunkStart);
    }

    function writeTagsChunk(w, tags) {
        const chunkStart = w.pos;
        w.writeDword(0);            // Chunk size (fill later)
        w.writeWord(0x2018);        // Chunk type
        w.writeWord(tags.length);   // Number of tags
        w.writeZeros(8);            // Reserved

        for (const tag of tags) {
            w.writeWord(tag.from);  // From frame
            w.writeWord(tag.to);    // To frame
            w.writeByte(0);         // Loop direction: Forward
            w.writeWord(0);         // Repeat: infinite
            w.writeZeros(6);        // Reserved

            // RGB color (deprecated but still used for compat)
            const rgb = hexToRgb(tag.color);
            w.writeByte(rgb.r);
            w.writeByte(rgb.g);
            w.writeByte(rgb.b);

            w.writeByte(0);         // Extra byte
            w.writeString(tag.name);
        }

        w.writeDwordAt(chunkStart, w.pos - chunkStart);
    }

    async function writeCelChunk(w, pixelData, width, height) {
        const chunkStart = w.pos;
        w.writeDword(0);            // Chunk size (fill later)
        w.writeWord(0x2005);        // Chunk type

        w.writeWord(0);             // Layer index
        w.writeShort(0);            // X position
        w.writeShort(0);            // Y position
        w.writeByte(255);           // Opacity
        w.writeWord(2);             // Cel type: Compressed Image
        w.writeShort(0);            // Z-index
        w.writeZeros(5);            // Reserved

        w.writeWord(width);         // Width
        w.writeWord(height);        // Height

        // Compress RGBA pixel data with zlib
        const compressed = await zlibCompress(pixelData);
        w.writeBytes(compressed);

        w.writeDwordAt(chunkStart, w.pos - chunkStart);
    }

    // ==============================
    // Decoder (read .aseprite/.ase)
    // ==============================
    class BinaryReader {
        constructor(buffer) {
            this.data = new Uint8Array(buffer);
            this.pos = 0;
        }
        readByte() { return this.data[this.pos++]; }
        readWord() {
            const v = this.data[this.pos] | (this.data[this.pos + 1] << 8);
            this.pos += 2;
            return v;
        }
        readShort() {
            const v = this.readWord();
            return v >= 0x8000 ? v - 0x10000 : v;
        }
        readDword() {
            const v = this.data[this.pos] | (this.data[this.pos + 1] << 8) |
                      (this.data[this.pos + 2] << 16) | ((this.data[this.pos + 3] << 24) >>> 0);
            this.pos += 4;
            return v;
        }
        readBytes(n) {
            const arr = this.data.slice(this.pos, this.pos + n);
            this.pos += n;
            return arr;
        }
        readString() {
            const len = this.readWord();
            const bytes = this.readBytes(len);
            return new TextDecoder().decode(bytes);
        }
        skip(n) { this.pos += n; }
    }

    async function zlibDecompress(data) {
        const stream = new Blob([data]).stream();
        const decompressedStream = stream.pipeThrough(new DecompressionStream('deflate'));
        const reader = decompressedStream.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    async function decode(buffer) {
        const r = new BinaryReader(buffer);

        // File Header (128 bytes)
        const fileSize = r.readDword();
        const magic = r.readWord();
        if (magic !== 0xA5E0) throw new Error('유효한 Aseprite 파일이 아닙니다');
        const numFrames = r.readWord();
        const width = r.readWord();
        const height = r.readWord();
        const colorDepth = r.readWord();
        r.skip(128 - 14); // Rest of header

        const frames = [];
        const delays = [];
        const tags = [];

        for (let fi = 0; fi < numFrames; fi++) {
            const frameStart = r.pos;
            const frameSize = r.readDword();
            const frameMagic = r.readWord();
            if (frameMagic !== 0xF1FA) throw new Error('잘못된 프레임 헤더');
            const oldChunkCount = r.readWord();
            const duration = r.readWord();
            r.skip(2); // Reserved
            const newChunkCount = r.readDword();
            const chunkCount = newChunkCount !== 0 ? newChunkCount : oldChunkCount;

            delays.push(duration || 100);
            let celPixels = null;

            for (let ci = 0; ci < chunkCount; ci++) {
                const chunkStart = r.pos;
                const chunkSize = r.readDword();
                const chunkType = r.readWord();

                if (chunkType === 0x2005) {
                    // Cel Chunk
                    const layerIndex = r.readWord();
                    const xPos = r.readShort();
                    const yPos = r.readShort();
                    const opacity = r.readByte();
                    const celType = r.readWord();
                    r.readShort(); // z-index
                    r.skip(5); // reserved

                    if (celType === 2) {
                        // Compressed Image
                        const celW = r.readWord();
                        const celH = r.readWord();
                        const compressedLen = chunkSize - (r.pos - chunkStart);
                        const compressed = r.readBytes(compressedLen);
                        const decompressed = await zlibDecompress(compressed);

                        // Place cel onto full-size canvas
                        celPixels = new Uint8Array(width * height * 4);
                        for (let y = 0; y < celH; y++) {
                            for (let x = 0; x < celW; x++) {
                                const destX = x + xPos;
                                const destY = y + yPos;
                                if (destX >= 0 && destX < width && destY >= 0 && destY < height) {
                                    const srcIdx = (y * celW + x) * 4;
                                    const dstIdx = (destY * width + destX) * 4;
                                    celPixels[dstIdx] = decompressed[srcIdx];
                                    celPixels[dstIdx + 1] = decompressed[srcIdx + 1];
                                    celPixels[dstIdx + 2] = decompressed[srcIdx + 2];
                                    celPixels[dstIdx + 3] = decompressed[srcIdx + 3];
                                }
                            }
                        }
                    } else if (celType === 0) {
                        // Raw Image
                        const celW = r.readWord();
                        const celH = r.readWord();
                        celPixels = new Uint8Array(width * height * 4);
                        const rawLen = celW * celH * (colorDepth / 8);
                        const raw = r.readBytes(rawLen);
                        for (let y = 0; y < celH; y++) {
                            for (let x = 0; x < celW; x++) {
                                const destX = x + xPos;
                                const destY = y + yPos;
                                if (destX >= 0 && destX < width && destY >= 0 && destY < height) {
                                    const srcIdx = (y * celW + x) * 4;
                                    const dstIdx = (destY * width + destX) * 4;
                                    celPixels[dstIdx] = raw[srcIdx];
                                    celPixels[dstIdx + 1] = raw[srcIdx + 1];
                                    celPixels[dstIdx + 2] = raw[srcIdx + 2];
                                    celPixels[dstIdx + 3] = raw[srcIdx + 3];
                                }
                            }
                        }
                    } else {
                        // Skip unsupported cel types
                        r.pos = chunkStart + chunkSize;
                    }
                } else if (chunkType === 0x2018) {
                    // Tags Chunk
                    const numTags = r.readWord();
                    r.skip(8); // Reserved
                    for (let ti = 0; ti < numTags; ti++) {
                        const from = r.readWord();
                        const to = r.readWord();
                        r.readByte(); // loop direction
                        r.readWord(); // repeat
                        r.skip(6); // reserved
                        const cr = r.readByte();
                        const cg = r.readByte();
                        const cb = r.readByte();
                        r.readByte(); // extra
                        const name = r.readString();
                        const color = '#' + cr.toString(16).padStart(2, '0') +
                                            cg.toString(16).padStart(2, '0') +
                                            cb.toString(16).padStart(2, '0');
                        tags.push({ name, from, to, color });
                    }
                } else {
                    // Skip other chunks
                    r.pos = chunkStart + chunkSize;
                }
            }

            if (celPixels) {
                frames.push(celPixels);
            } else {
                // Empty frame
                frames.push(new Uint8Array(width * height * 4));
            }

            r.pos = frameStart + frameSize;
        }

        return { width, height, frames, delays, tags };
    }

    // Public API
    return { encode, decode };
})();
