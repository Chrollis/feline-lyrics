export function halfToFloat32(source: Uint16Array): Float32Array {
    const output = new Float32Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
        const half = source[index];
        const sign = (half & 0x8000) === 0 ? 1 : -1;
        const exponent = (half >> 10) & 0x1f;
        const fraction = half & 0x3ff;
        let value: number;
        if (exponent === 0) {
            value = fraction * 2 ** -24;
        } else if (exponent === 0x1f) {
            value = fraction === 0 ? Number.POSITIVE_INFINITY : Number.NaN;
        } else {
            value = (1 + fraction / 1024) * 2 ** (exponent - 15);
        }
        output[index] = sign * value;
    }
    return output;
}
