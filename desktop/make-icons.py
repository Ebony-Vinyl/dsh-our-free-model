# 生成桌面应用图标：从仓库 icon.svg 内嵌的位图提取主体，
# 按深色圆角底板重新合成，输出 Tauri 需要的全部尺寸。
# 仅构建期使用，不进入应用运行时。
import base64
import io
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

REPO = Path(__file__).resolve().parents[1]
SVG = (REPO / "icon.svg").read_text(encoding="utf-8")
OUT = Path(__file__).resolve().parent / "icons"

match = re.search(r'href="data:image/jpeg;base64,([^"]+)"', SVG)
if not match:
    sys.exit("icon.svg 中未找到内嵌位图")
source = Image.open(io.BytesIO(base64.b64decode(match.group(1)))).convert("RGBA")


def cover(img: Image.Image, size: int) -> Image.Image:
    return ImageOps.fit(img, (size, size), Image.LANCZOS)


def rounded_card(img: Image.Image, size: int) -> Image.Image:
    scale = 4
    big = size * scale
    card = cover(img, big)
    # 轻微压暗外圈，保证在浅色任务栏上也有轮廓
    background = Image.new("RGBA", (big, big), (13, 18, 32, 255))
    background.paste(card, (0, 0), card)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * 0.22), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(background.resize((size, size), Image.LANCZOS), (0, 0), mask)
    return result


OUT.mkdir(exist_ok=True)
sizes = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}
for name, size in sizes.items():
    rounded_card(source, size).save(OUT / name)

ico_sizes = [16, 24, 32, 48, 64, 128, 256]
rounded_card(source, 256).save(OUT / "icon.ico", sizes=[(s, s) for s in ico_sizes])

# Tray 专用：32px 原图（小尺寸不过度圆角，保证可辨识）
cover(source, 32).save(OUT / "tray.png")
print("icons written to", OUT)
