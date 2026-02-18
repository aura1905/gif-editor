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

    // Public API
    return { encode };
})();
