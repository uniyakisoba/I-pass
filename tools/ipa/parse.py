"""OCR結果(TSV)を1問ずつに切り分け、問題部分の画像も切り抜く。
使い方: python3 parse.py r06
出力: r06_draft.txt（確認用テキスト） / r06_draft.json / crops/r06_q001.jpg ...
"""
import csv, glob, json, os, re, sys
from PIL import Image

year = sys.argv[1]
base = os.path.dirname(os.path.abspath(__file__))
os.chdir(base)
os.makedirs('crops', exist_ok=True)

ans_txt = open(f'{year}_ans.txt', encoding='utf-8').read()
answers = {int(n): k for n, k in re.findall(r'問\s*(\d+)\s+([アイウエ])', ans_txt)}

START = re.compile(r'^\s*[問間閣聞閑門開関]\s*([0-9OoIl]{1,4})')
FOOTER = re.compile(r'^[\s\-ー一―‐−~〜]*\d{1,3}[\s\-ー一―‐−~〜]*$')

def page_lines(tsv):
    lines = {}
    with open(tsv, encoding='utf-8') as f:
        for row in csv.DictReader(f, delimiter='\t', quoting=csv.QUOTE_NONE):
            if row['level'] != '5' or not row['text'].strip():
                continue
            key = (int(row['block_num']), int(row['par_num']), int(row['line_num']))
            l, t, w, h = (int(row[k]) for k in ('left', 'top', 'width', 'height'))
            d = lines.setdefault(key, {'words': [], 'l': l, 't': t, 'r': l + w, 'b': t + h})
            d['words'].append((l, l + w, row['text']))
            d['l'] = min(d['l'], l); d['t'] = min(d['t'], t); d['r'] = max(d['r'], l + w); d['b'] = max(d['b'], t + h)
    out = []
    for d in lines.values():
        text = ''; prev_r = None
        for wl, wr, w in sorted(d['words']):
            if text:
                gap = wl - prev_r
                if gap > 22 or (text[-1].isascii() and w[0].isascii() and gap > 6):
                    text += '  ' if gap > 22 else ' '
            text += w; prev_r = wr
        if FOOTER.match(text) and d['t'] > 1800:
            continue
        out.append({'text': text, 'l': d['l'], 't': d['t'], 'r': d['r'], 'b': d['b']})
    out.sort(key=lambda x: (x['t'], x['l']))
    return out

pages = sorted(glob.glob(f'{year}/p-*.jpg'))
qs = {}          # num -> {'segs': [(page, top, bottom)], 'lines': [...]}
cur = None
expect = 1
for pi, img in enumerate(pages):
    tsv = img + '.ocr.tsv'
    if not os.path.exists(tsv):
        print('missing OCR', tsv); continue
    lines = page_lines(tsv)
    for ln in lines:
        m = START.match(ln['text'])
        if m and ln['l'] < 300 and not re.search(r'までは|系の問題', ln['text']) and expect <= 100:
            if cur is not None:
                seg = qs[cur]['segs'][-1]
                if seg[0] == pi:
                    seg[2] = ln['t'] - 12
            cur = expect; expect += 1
            qs[cur] = {'segs': [[pi, ln['t'] - 14, None]], 'lines': [], 'pos': []}
        if cur is None:
            continue
        q = qs[cur]
        if q['segs'][-1][0] != pi:
            q['segs'].append([pi, max(0, ln['t'] - 14), None])
        q['lines'].append(ln['text'])
        q['pos'].append((pi, ln['t'], ln['b'], ln['l'], ln['text']))
        seg = q['segs'][-1]
        seg[2] = max(seg[2] or 0, ln['b'] + 14)
    # ページ末尾で区切る（次の問題が別ページで始まる場合）

print(year, 'questions found:', len(qs), 'answers:', len(answers))
missing = [n for n in range(1, 101) if n not in qs]
if missing:
    print('missing questions:', missing)

drafts = []
with open(f'{year}_draft.txt', 'w', encoding='utf-8') as f:
    for n in sorted(qs):
        q = qs[n]
        crops = []
        segs = q['segs'][:1] if n == 100 else q['segs']
        nxt = qs.get(n + 1)
        for si, (pi, top, bot) in enumerate(segs):
            im = Image.open(pages[pi]).convert('L')
            # 次の問題が同じページで始まるならその直前まで、そうでなければページ下端（フッター手前）まで
            if nxt and nxt['segs'][0][0] == pi:
                bot = nxt['segs'][0][1] + 2
            elif si == len(segs) - 1 or True:
                bot = im.height - 150
            c = im.crop((90, max(0, top), im.width - 90, min(im.height, bot)))
            # 下側の余白を削る
            inv = c.point(lambda v: 255 if v < 200 else 0)
            bb = inv.getbbox()
            if bb:
                c = c.crop((0, 0, c.width, min(c.height, bb[3] + 20)))
            crops.append(c)
        w = max(c.width for c in crops); h = sum(c.height for c in crops)
        out = Image.new('L', (w, h), 255); y = 0
        for c in crops:
            out.paste(c.convert('L'), (0, y)); y += c.height
        name = f'crops/{year}_q{n:03d}.jpg'
        out.save(name, quality=70, optimize=True)
        # 図表だけの切り抜き：問題文の段落の直後から、選択肢「ア」の行の手前まで
        pos = q['pos']
        fig_top = None
        for i in range(1, len(pos)):
            if pos[i][0] != pos[0][0] or pos[i][1] - pos[i - 1][2] > 45:
                fig_top = (pos[i][0], pos[i - 1][2] + 18); break
        fig_end = None
        for (pi, t, b_, l, tx) in pos:
            if fig_top and (pi, t) > fig_top and l < 300 and re.match(r'^\s*ア', tx):
                fig_end = (pi, t - 12); break
        if fig_top:
            fpi = fig_top[0]
            im = Image.open(pages[fpi]).convert('L')
            if fig_end and fig_end[0] == fpi:
                bot = fig_end[1]
            elif nxt and nxt['segs'][0][0] == fpi:
                bot = nxt['segs'][0][1] + 2
            else:
                bot = im.height - 150
            c = im.crop((60, fig_top[1], im.width - 60, max(fig_top[1] + 20, bot)))
            inv = c.point(lambda v: 255 if v < 200 else 0)
            bb = inv.getbbox()
            if bb:
                c = c.crop((max(0, bb[0] - 16), max(0, bb[1] - 16), min(c.width, bb[2] + 16), min(c.height, bb[3] + 16)))
                c.save(f'crops/{year}_q{n:03d}_fig.jpg', quality=75, optimize=True)
        drafts.append({'n': n, 'a': answers.get(n), 'lines': q['lines'], 'img': name, 'pages': [s[0] for s in q['segs']]})
        f.write(f'### {n} [正解:{answers.get(n)}] pages={[s[0] for s in q["segs"]]}\n')
        f.write('\n'.join(q['lines']) + '\n\n')
json.dump(drafts, open(f'{year}_draft.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
