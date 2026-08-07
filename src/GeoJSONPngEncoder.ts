/**
 * ラスタタイルを PNG のバイト列にする部分。
 *
 * canvas の `toDataURL` を使わない。base64 を経由するぶん無駄が大きく、
 * OffscreenCanvas が無い環境でも動かす必要があるため。
 * 圧縮はせず zlib の格納（無圧縮）ブロックを並べる。展開はブラウザの
 * PNG デコーダが行うので、こちらで縮める意味が薄い。
 *
 * android-sdk の `FastPngEncoder.kt` に対応する。
 */

// ─── PNG encoder ─────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? ((0xedb88320 ^ (c >>> 1)) | 0) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32Init(): number { return -1; }
function crc32Update(crc: number, data: Uint8Array | Uint8ClampedArray, offset: number, len: number): number {
    for (let i = offset; i < offset + len; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return crc;
}
function crc32Finalize(crc: number): number { return (crc ^ -1) >>> 0; }

const ADLER_MOD = 65521;
function adler32Update(s: number, data: Uint8Array | Uint8ClampedArray, offset: number, len: number): number {
    let s1 = s & 0xffff, s2 = (s >>> 16) & 0xffff;
    for (let i = offset; i < offset + len; i++) { s1 = (s1 + data[i]) % ADLER_MOD; s2 = (s2 + s1) % ADLER_MOD; }
    return ((s2 << 16) | s1) >>> 0;
}

export class DynamicBuffer {
    private buf: Uint8Array;
    private count = 0;
    constructor(cap = 4096) { this.buf = new Uint8Array(Math.max(cap, 16)); }
    position(): number { return this.count; }
    reset(): void { this.count = 0; }
    private grow(min: number): void {
        if (this.buf.length >= min) return;
        let n = this.buf.length;
        while (n < min) n = (n * 2) | 0;
        const next = new Uint8Array(n);
        next.set(this.buf.subarray(0, this.count));
        this.buf = next;
    }
    writeByte(v: number): void { this.grow(this.count + 1); this.buf[this.count++] = v & 0xff; }
    writeInt32BE(v: number): void {
        this.grow(this.count + 4);
        this.buf[this.count++] = (v >>> 24) & 0xff;
        this.buf[this.count++] = (v >>> 16) & 0xff;
        this.buf[this.count++] = (v >>> 8) & 0xff;
        this.buf[this.count++] = v & 0xff;
    }
    setInt32BE(offset: number, v: number): void {
        this.buf[offset] = (v >>> 24) & 0xff; this.buf[offset + 1] = (v >>> 16) & 0xff;
        this.buf[offset + 2] = (v >>> 8) & 0xff; this.buf[offset + 3] = v & 0xff;
    }
    writeBytes(src: Uint8Array | Uint8ClampedArray, offset = 0, len = src.length): void {
        if (len <= 0) return;
        this.grow(this.count + len);
        for (let i = 0; i < len; i++) this.buf[this.count + i] = src[offset + i];
        this.count += len;
    }
    toUint8Array(): Uint8Array { return this.buf.slice(0, this.count); }
}

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = new Uint8Array([0x49, 0x48, 0x44, 0x52]);
const PNG_IDAT = new Uint8Array([0x49, 0x44, 0x41, 0x54]);
const PNG_IEND = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);
const ZLIB_HEADER = new Uint8Array([0x78, 0x01]);
const EMPTY_BYTES = new Uint8Array(0);

function writePngChunk(buf: DynamicBuffer, type: Uint8Array, data: Uint8Array | Uint8ClampedArray, offset: number, len: number): void {
    buf.writeInt32BE(len);
    buf.writeBytes(type);
    if (len > 0) buf.writeBytes(data, offset, len);
    let crc = crc32Init();
    crc = crc32Update(crc, type, 0, type.length);
    if (len > 0) crc = crc32Update(crc, data, offset, len);
    buf.writeInt32BE(crc32Finalize(crc));
}

export function encodePng(rgba: Uint8ClampedArray, width: number, height: number, pngBuf: DynamicBuffer): Uint8Array {
    pngBuf.reset();
    pngBuf.writeBytes(PNG_SIG);

    const ihdrBuf = new Uint8Array(13);
    ihdrBuf[0] = (width >>> 24) & 0xff; ihdrBuf[1] = (width >>> 16) & 0xff;
    ihdrBuf[2] = (width >>> 8) & 0xff;  ihdrBuf[3] = width & 0xff;
    ihdrBuf[4] = (height >>> 24) & 0xff; ihdrBuf[5] = (height >>> 16) & 0xff;
    ihdrBuf[6] = (height >>> 8) & 0xff;  ihdrBuf[7] = height & 0xff;
    ihdrBuf[8] = 8; ihdrBuf[9] = 6; // bit depth=8, color type=RGBA
    writePngChunk(pngBuf, PNG_IHDR, ihdrBuf, 0, 13);

    const rowLen = 1 + width * 4;
    const rowBuf = new Uint8Array(rowLen);
    const sbhBuf = new Uint8Array(5);
    const adlerBuf = new Uint8Array(4);

    const idatLenPos = pngBuf.position();
    pngBuf.writeInt32BE(0);
    pngBuf.writeBytes(PNG_IDAT);
    let crc = crc32Init();
    crc = crc32Update(crc, PNG_IDAT, 0, 4);
    const idatDataStart = pngBuf.position();

    crc = crc32Update(crc, ZLIB_HEADER, 0, 2);
    pngBuf.writeBytes(ZLIB_HEADER);

    let adler = 1;
    for (let y = 0; y < height; y++) {
        rowBuf[0] = 0;
        const srcBase = y * width * 4;
        for (let i = 0; i < width * 4; i++) rowBuf[1 + i] = rgba[srcBase + i];
        adler = adler32Update(adler, rowBuf, 0, rowLen);

        const isLast = y === height - 1;
        const nlen = (~rowLen) & 0xffff;
        sbhBuf[0] = isLast ? 0x01 : 0x00;
        sbhBuf[1] = rowLen & 0xff; sbhBuf[2] = (rowLen >>> 8) & 0xff;
        sbhBuf[3] = nlen & 0xff; sbhBuf[4] = (nlen >>> 8) & 0xff;
        crc = crc32Update(crc, sbhBuf, 0, 5);
        pngBuf.writeBytes(sbhBuf, 0, 5);
        crc = crc32Update(crc, rowBuf, 0, rowLen);
        pngBuf.writeBytes(rowBuf, 0, rowLen);
    }

    adlerBuf[0] = (adler >>> 24) & 0xff; adlerBuf[1] = (adler >>> 16) & 0xff;
    adlerBuf[2] = (adler >>> 8) & 0xff; adlerBuf[3] = adler & 0xff;
    crc = crc32Update(crc, adlerBuf, 0, 4);
    pngBuf.writeBytes(adlerBuf);

    pngBuf.setInt32BE(idatLenPos, pngBuf.position() - idatDataStart);
    pngBuf.writeInt32BE(crc32Finalize(crc));
    writePngChunk(pngBuf, PNG_IEND, EMPTY_BYTES, 0, 0);
    return pngBuf.toUint8Array();
}
