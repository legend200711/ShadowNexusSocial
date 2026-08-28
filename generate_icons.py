"""
Shadow Nexus Social — Fast Icon Generator
Uses Python built-ins only. Renders at 64px then scales up for large sizes.
"""
import struct, zlib, math, os

# Brand colours (R,G,B,A)
BG     = (0,   20,  60,  255)
RING   = (0,  102, 255, 255)
DARK   = (0,    8,  24,  255)
MOON   = (220, 240, 255, 255)
STAR   = (200, 230, 255, 180)

def make_png(rgba_bytes, w, h):
    rows = []
    rs = w * 4
    for y in range(h):
        rows.append(b'\x00' + rgba_bytes[y*rs:(y+1)*rs])
    idat = zlib.compress(b''.join(rows), 1)
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
    ihdr = struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0])
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

def blend(src, dst):
    sa = src[3] / 255.0
    da = dst[3] / 255.0
    oa = sa + da * (1 - sa)
    if oa == 0: return (0,0,0,0)
    r = int((src[0]*sa + dst[0]*da*(1-sa)) / oa)
    g = int((src[1]*sa + dst[1]*da*(1-sa)) / oa)
    b = int((src[2]*sa + dst[2]*da*(1-sa)) / oa)
    return (r, g, b, int(oa*255))

def render_64():
    """Render the icon at exactly 64x64."""
    S = 64
    cx = cy = S / 2.0
    buf = bytearray(S * S * 4)

    # Fill background
    for i in range(S * S):
        buf[i*4:i*4+4] = BG

    for y in range(S):
        for x in range(S):
            px, py = x + 0.5, y + 0.5
            dx, dy = px - cx, py - cy
            d = math.sqrt(dx*dx + dy*dy)

            ro, ri = S*0.44, S*0.38
            mbr     = S*0.355
            cr      = S*0.28
            sr_     = cr * 0.82
            sox     = cr * 0.32
            soy     = cr * -0.05
            scx_    = cx + sox
            scy_    = cy + soy

            r0,g0,b0,a0 = buf[y*S*4+x*4], buf[y*S*4+x*4+1], buf[y*S*4+x*4+2], buf[y*S*4+x*4+3]
            col = (r0,g0,b0,a0)

            # Ring
            if ri - 1 <= d <= ro + 1:
                aa = min(1.0, ro - d + 0.5) * min(1.0, d - ri + 0.5)
                if aa > 0:
                    col = blend((RING[0],RING[1],RING[2],int(RING[3]*aa)), col)

            # Dark disc
            if d <= mbr + 1:
                aa = min(1.0, mbr - d + 0.5)
                col = blend((DARK[0],DARK[1],DARK[2],int(DARK[3]*aa)), col)

            # Crescent
            ds = math.sqrt((px-scx_)**2 + (py-scy_)**2)
            if d < cr + 1 and not (ds < sr_ - 1):
                oa2 = min(1.0, cr - d + 0.5)
                ia  = min(1.0, ds - sr_ + 0.5)
                aa = max(0.0, min(oa2, ia))
                if aa > 0:
                    col = blend((MOON[0],MOON[1],MOON[2],int(MOON[3]*aa)), col)

            # Stars
            for sx2, sy2, sr2 in [
                (cx+S*0.18, cy-S*0.22, max(1.2, S*0.022)),
                (cx-S*0.24, cy-S*0.14, max(1.0, S*0.018)),
                (cx+S*0.08, cy+S*0.26, max(1.0, S*0.018)),
            ]:
                dd = math.sqrt((px-sx2)**2 + (py-sy2)**2)
                aa = max(0.0, min(1.0, sr2 - dd + 0.5))
                if aa > 0:
                    col = blend((STAR[0],STAR[1],STAR[2],int(STAR[3]*aa)), col)

            buf[y*S*4+x*4+0] = col[0]
            buf[y*S*4+x*4+1] = col[1]
            buf[y*S*4+x*4+2] = col[2]
            buf[y*S*4+x*4+3] = col[3]

    return buf, S

def scale_nearest(src_buf, src_w, src_h, dst_w, dst_h):
    """Nearest-neighbour upscale."""
    out = bytearray(dst_w * dst_h * 4)
    for y in range(dst_h):
        sy = int(y * src_h / dst_h)
        for x in range(dst_w):
            sx = int(x * src_w / dst_w)
            si = (sy * src_w + sx) * 4
            di = (y  * dst_w + x)  * 4
            out[di:di+4] = src_buf[si:si+4]
    return out

def scale_bilinear(src_buf, src_w, src_h, dst_w, dst_h):
    """Bilinear upscale — smoother for large icons."""
    out = bytearray(dst_w * dst_h * 4)
    for y in range(dst_h):
        # map dst y → src float coord
        fy = (y + 0.5) * src_h / dst_h - 0.5
        y0 = max(0, int(fy))
        y1 = min(src_h - 1, y0 + 1)
        ty = fy - y0
        for x in range(dst_w):
            fx = (x + 0.5) * src_w / dst_w - 0.5
            x0 = max(0, int(fx))
            x1 = min(src_w - 1, x0 + 1)
            tx = fx - x0

            def px(row, col):
                i = (row * src_w + col) * 4
                return src_buf[i:i+4]

            def lerp_px(a, b, t):
                return [int(a[i] + (b[i] - a[i]) * t) for i in range(4)]

            top    = lerp_px(px(y0,x0), px(y0,x1), tx)
            bottom = lerp_px(px(y1,x0), px(y1,x1), tx)
            result = lerp_px(top, bottom, ty)

            di = (y * dst_w + x) * 4
            out[di:di+4] = result

    return bytes(out)

def make_ico(png16, png32):
    num = 2
    header = struct.pack('<HHH', 0, 1, num)
    data_offset = 6 + num * 16
    entries = b''
    images = [png16, png32]
    sizes  = [16, 32]
    off = data_offset
    for i, s in enumerate(sizes):
        entries += struct.pack('<BBBBHHII', s, s, 0, 0, 1, 32, len(images[i]), off)
        off += len(images[i])
    return header + entries + b''.join(images)

def main():
    out = os.path.dirname(os.path.abspath(__file__))
    print("Shadow Nexus Social — generating icons...")

    src_buf, src_s = render_64()
    print("  ✓  Base 64x64 rendered")

    specs = [
        ('favicon-16x16.png',    16,  'nearest'),
        ('favicon-32x32.png',    32,  'nearest'),
        ('apple-touch-icon.png', 180, 'bilinear'),
        ('icon-192.png',         192, 'bilinear'),
        ('icon-512.png',         512, 'nearest'),
    ]

    pngs = {}
    for filename, size, method in specs:
        if method == 'nearest':
            scaled = scale_nearest(src_buf, src_s, src_s, size, size)
        else:
            scaled = scale_bilinear(src_buf, src_s, src_s, size, size)
        data = make_png(bytes(scaled) if isinstance(scaled, bytearray) else scaled, size, size)
        path = os.path.join(out, filename)
        with open(path, 'wb') as f:
            f.write(data)
        pngs[size] = data
        print(f"  ✓  {filename}  ({size}x{size}, {len(data):,} bytes)")

    ico = make_ico(pngs[16], pngs[32])
    with open(os.path.join(out, 'favicon.ico'), 'wb') as f:
        f.write(ico)
    print(f"  ✓  favicon.ico  (16+32 multi-size, {len(ico):,} bytes)")

    print("\nAll icons generated!")

if __name__ == '__main__':
    main()
