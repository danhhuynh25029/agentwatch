"""Builds the README tour GIF from tall panel screenshots (1100 css px wide).
Usage: python3 make_gif.py <dir with session/conversation/dashboard/compare.png> <out.gif>"""
import sys
from PIL import Image, ImageDraw, ImageFont

TALL, OUT = sys.argv[1], sys.argv[2]
W, VIEW, BAR = 1100, 700, 64
H = VIEW + BAR
BG, BAR_BG, FG, DIM, ACCENT = (31, 31, 31), (24, 24, 24), (230, 230, 230), (150, 150, 150), (209, 134, 22)


def font(names, size):
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            pass
    return ImageFont.load_default()


SANS = ['/System/Library/Fonts/Helvetica.ttc', 'DejaVuSans.ttf']
f_cap, f_step, f_title, f_body = font(SANS, 22), font(SANS, 15), font(SANS, 46), font(SANS, 22)
f_mono = font(['/System/Library/Fonts/Menlo.ttc', 'DejaVuSansMono.ttf'], 20)


def load(name):
    im = Image.open(f'{TALL}/{name}.png').convert('RGB')
    w, h = im.size
    px = im.load()
    bg = px[w - 2, h - 2]
    y = h - 1
    while y > VIEW and all(px[x, y] == bg for x in range(0, w, 7)):
        y -= 1
    return im.crop((0, 0, W, max(y + 40, VIEW)))


pages = {n: load(n) for n in ['session', 'conversation', 'dashboard', 'compare']}


def find(page, text_y_fraction):
    return int(pages[page].height * text_y_fraction)


frames, durations = [], []


def add(img, ms):
    frames.append(img)
    durations.append(ms)


def view(page, y, step, caption):
    img = Image.new('RGB', (W, H), BAR_BG)
    y = max(0, min(int(y), pages[page].height - VIEW))
    img.paste(pages[page].crop((0, y, W, y + VIEW)), (0, BAR))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((20, 18, 52, 46), 6, fill=ACCENT)
    d.text((36, 32), str(step), font=f_step, fill=(20, 20, 20), anchor='mm')
    d.text((66, 32), caption, font=f_cap, fill=FG, anchor='lm')
    d.line((0, BAR - 1, W, BAR - 1), fill=(60, 60, 60))
    return img


def card(lines):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    y = H // 2 - sum(gap for _, _, gap, _ in lines) // 2
    for text, f, gap, color in lines:
        d.text((W // 2, y), text, font=f, fill=color, anchor='mt')
        y += gap
    return img


def fade(a, b, n=5):
    for i in range(1, n + 1):
        add(Image.blend(a, b, i / (n + 1)), 50)


def scroll(page, y0, y1, step, caption, n=10):
    for i in range(1, n + 1):
        t = i / n
        e = t * t * (3 - 2 * t)
        add(view(page, y0 + (y1 - y0) * e, step, caption), 45)


title = card([
    ('Agent Session Watch', f_title, 80, FG),
    ('What your Claude Code sessions cost, and what drove the cost:', f_body, 34, DIM),
    ('prompts, subagents, context, tools and commits.', f_body, 70, DIM),
    ('Open the AgentWatch icon in the activity bar, then click a session.', f_body, 60, FG),
    ('Demo with fictional sessions', f_step, 0, DIM),
])
add(title, 3500)

scenes = [
    ('session', [
        (0, 3400, 1, 'Cost first: estimated cost, tokens, cache hit, duration'),
        (find('session', 0.085), 3600, 2, 'Cost drivers: each thread and each prompt, ranked'),
        (find('session', 0.225), 3600, 3, 'Context: scrub through the session, see the starting context'),
        (find('session', 0.635), 3200, 4, 'Subagents, commits with their cost, files changed, errors'),
    ]),
    ('conversation', [
        (0, 3000, 5, 'Conversation viewer: tool calls folded, replay mode'),
    ]),
    ('dashboard', [
        (0, 3200, 6, 'Usage dashboard: totals and 5-hour usage blocks'),
        (find('dashboard', 0.44), 3000, 7, 'Cost per project, model and git branch'),
    ]),
    ('compare', [
        (0, 3200, 8, 'Compare two sessions metric by metric'),
    ]),
]

prev = title
for page, stops in scenes:
    y, hold, step, cap = stops[0]
    first = view(page, y, step, cap)
    fade(prev, first)
    add(first, hold)
    for (y0, _, _, _), (y1, hold, step, cap) in zip(stops, stops[1:]):
        scroll(page, y0, y1, step, cap)
        add(view(page, y1, step, cap), hold)
    prev = frames[-1]

outro = card([
    ('Install', f_title, 70, FG),
    ('code --install-extension HunhNgcCngDanh.agentwatch', f_mono, 56, ACCENT),
    ('Also: prompt cache timer, loop alerts, budgets, full-text search,', f_body, 34, DIM),
    ('resume in Claude Code, export to Markdown.', f_body, 0, DIM),
])
fade(prev, outro)
add(outro, 4000)

pal = [f.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
pal[0].save(OUT, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(len(frames), 'frames', sum(durations) / 1000, 's')
