"""
旅行プランナーのPWA用アイコン生成スクリプト
icon-192.png と icon-512.png を生成する
"""
from PIL import Image, ImageDraw

# カラーパレット
BG = (30, 58, 138, 255)        # 青 #1e3a8a
PIN = (233, 30, 99, 255)        # ビビッドピンク #E91E63（訪問済ピンと統一）
WHITE = (255, 255, 255, 255)
SHADOW = (0, 0, 0, 60)


def make_icon(size, output_path):
    """指定サイズのアイコンPNGを生成。
    内部的に4倍サイズで描画してアンチエイリアス効果を得る。
    """
    scale = 4
    s = size * scale

    img = Image.new('RGBA', (s, s), BG)
    draw = ImageDraw.Draw(img)

    # ピンの中心座標と半径
    cx = s // 2
    cy = int(s * 0.42)
    r = int(s * 0.22)
    border = int(s * 0.025)

    # ピン尾部の頂点
    tail_bottom_y = cy + int(s * 0.32)
    tail_half_w = int(r * 0.65)
    tail_top_y = cy + int(r * 0.55)

    # --- 白い縁取り(外側)を先に描画 ---
    # 円（外側）
    draw.ellipse(
        [cx - r - border, cy - r - border, cx + r + border, cy + r + border],
        fill=WHITE
    )
    # 尾部（外側）
    draw.polygon(
        [
            (cx - tail_half_w - border, tail_top_y),
            (cx + tail_half_w + border, tail_top_y),
            (cx, tail_bottom_y + border * 2),
        ],
        fill=WHITE
    )

    # --- ピンクの本体 ---
    # 円
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=PIN)
    # 尾部
    draw.polygon(
        [
            (cx - tail_half_w, tail_top_y),
            (cx + tail_half_w, tail_top_y),
            (cx, tail_bottom_y),
        ],
        fill=PIN
    )

    # --- 中央の白い点 ---
    dot_r = int(r * 0.42)
    draw.ellipse(
        [cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
        fill=WHITE
    )

    # 縮小（高品質リサンプル）
    img = img.resize((size, size), Image.LANCZOS)
    img.save(output_path, 'PNG')
    print(f"Created {output_path} ({size}x{size})")


if __name__ == '__main__':
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    make_icon(192, os.path.join(here, 'icon-192.png'))
    make_icon(512, os.path.join(here, 'icon-512.png'))
    print("完了。")
