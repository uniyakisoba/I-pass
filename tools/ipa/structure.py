"""draft.json を「問題文＋選択肢4つ」に自動整形する。
使い方: python3 structure.py r06   → r06_struct.json と r06_review.txt（確認用）
"""
import json, re, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
year = sys.argv[1]
d = json.load(open(f'{year}_draft.json', encoding='utf-8'))

JP = r'[^\x00-\x7f]'
def clean(s):
    s = re.sub(rf'(?<={JP})\s+(?={JP})', '', s)           # 日本語どうしの空白を詰める
    s = re.sub(rf'(?<={JP})\s+(?=[A-Za-z0-9(])', '', s) if False else s
    s = re.sub(r'\s*,\s*(?![0-9]{3})', '，', s)               # 読点
    s = s.replace('牙まえ', '踏まえ').replace('かもの', 'もの').replace('0SS', 'OSS').replace('0pen', 'Open')
    s = re.sub(r'(?<![A-Za-z0-9])0S(?![A-Za-z])', 'OS', s)
    s = s.replace('ToT', 'IoT').replace('toT', 'IoT').replace('IoTf', 'IoT')
    s = re.sub(r'\s{2,}', ' ', s)
    return s.strip()

KANA = 'アイウエ'
out = []
for q in d:
    lines = [l for l in q['lines']]
    lines[0] = re.sub(r'^\s*\S\s*[0-9OoIl]{1,4}\s*', '', lines[0])   # 先頭の「問N」を除去
    qtext, ch, curc = [], {}, None
    for ln in lines:
        # 行内の選択肢記号で分割（「ア 2.5 イ 3.3 ...」のような横並びに対応）
        parts = re.split(r'(?:^\s*|\s{2,})([アイウエ])(?=\s|[^ァ-ヶー])', ln)
        if len(parts) > 1 and re.match(r'^\s*[アイウエ]', ln):
            pre = parts[0]
            if pre.strip() and curc:
                ch[curc] += pre
            for i in range(1, len(parts), 2):
                k, v = parts[i], parts[i + 1]
                if k in ch and curc and KANA.index(k) <= KANA.index(curc):
                    ch[curc] += k + v; continue
                curc = k; ch[k] = v
        elif curc:
            ch[curc] += ln
        else:
            qtext.append(ln)
    qt = clean(' '.join(qtext))
    chs = [clean(ch.get(k, '')) for k in KANA]
    fig = bool(re.search(r'図|表|次の|グラフ|フローチャート|プログラム|ア[～~]エ', qt)) or any(len(c) == 0 for c in chs)
    out.append({'n': q['n'], 'a': q['a'], 'q': qt, 'ch': chs, 'fig': fig, 'img': q['img']})

json.dump(out, open(f'{year}_struct.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
with open(f'{year}_review.txt', 'w', encoding='utf-8') as f:
    for q in out:
        f.write(f"#{q['n']} 正:{q['a']}{' 図?' if q['fig'] else ''}\nQ {q['q']}\n" + ''.join(f'{k} {c}\n' for k, c in zip(KANA, q['ch'])) + '\n')
print(year, 'fig-suspect:', sum(q['fig'] for q in out), 'empty-choice:', sum(any(not c for c in q['ch']) for q in out))
