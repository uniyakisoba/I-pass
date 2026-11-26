"""修正ファイル(fix_rXX.txt)をOCR整形結果に適用し、アプリ用の js/past_questions.js を作る。
使い方: python3 apply.py /home/user/I-pass
"""
import json, os, re, sys
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
repo = sys.argv[1]
CAT = {'法': '企業と法務', '経': '経営戦略', 'シ': 'システム戦略', '開': '開発技術', 'プ': 'プロジェクトマネジメント',
       'サ': 'サービスマネジメント', '基': '基礎理論', 'コ': 'コンピュータシステム', '技': '技術要素'}
FIELD_OF = {c: f for f, cs in {'S': '法経シ', 'M': '開プサ', 'T': '基コ技'}.items() for c in cs}
YEARS = {  # 年度表示, 分野の区切り（ストラテジ最終問, マネジメント最終問）
    'r06': ('令和6年度', 35, 55),
    'r07': ('令和7年度', 35, 55),
    'r08': ('令和8年度', 34, 54),
}
KANA = 'アイウエ'
SUSPECT = re.compile(r'ーー|[|=^~_]|二=|ee|[A-Z]{2}0\b|[ァ-ヶ]{2}エエ|。。')

def parse_fix(path):
    items, cur = {}, None
    for raw in open(path, encoding='utf-8'):
        line = raw.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        if line.startswith('@'):
            cur = items.setdefault(int(line[1:]), {'r': []}); continue
        key, _, val = line.partition(' ')
        if key == 'r':
            for pair in val.split('|'):
                old, _, new = pair.partition('=>')
                cur['r'].append((old, new))
        elif key == 'img':
            cur['img'] = 'full' if val.strip() == 'full' else True
        else:
            cur[key] = val
    return items

out, warnings = [], []
os.makedirs(os.path.join(repo, 'img', 'past'), exist_ok=True)
for y, (label, s_end, m_end) in YEARS.items():
    fix_path = os.path.join(here, f'fix_{y}.txt')
    if not os.path.exists(fix_path):
        continue
    fixes = parse_fix(fix_path)
    struct = {q['n']: q for q in json.load(open(os.path.join(here, f'{y}_struct.json'), encoding='utf-8'))}
    for n in sorted(fixes):
        fx, q = fixes[n], struct[n]
        qt = fx.get('q', q['q'])
        ch = fx['ch'].split('|') if 'ch' in fx else list(q['ch'])
        for old, new in fx['r']:
            qt = qt.replace(old, new)
            ch = [c.replace(old, new) for c in ch]
        field = 'S' if n <= s_end else 'M' if n <= m_end else 'T'
        cat = CAT[fx['c']]
        if FIELD_OF[fx['c']] != field:
            warnings.append(f'{y} 問{n}: 大分類 {cat} が分野 {field} と不一致')
        if len(ch) != 4 or any(not c.strip() for c in ch):
            warnings.append(f'{y} 問{n}: 選択肢が4つそろっていない {ch}')
        if 'ex' not in fx:
            warnings.append(f'{y} 問{n}: 解説なし')
        for t in [qt] + ch:
            m = SUSPECT.search(t)
            if m:
                warnings.append(f'{y} 問{n}: 誤読の疑い「{m.group(0)}」 in {t[:40]}')
        item = {'id': f'{y.upper()}-{n:03d}', 'f': field, 'c': cat, 'q': qt.strip(), 'ch': [c.strip() for c in ch],
                'a': KANA.index(q['a']), 'keep': 1, 'ex': fx.get('ex', ''), 'src': f'{label} ITパスポート試験 公開問題 問{n}'}
        if fx.get('img'):
            src = os.path.join(here, q['img'])
            fig = src.replace('.jpg', '_fig.jpg')
            if fx['img'] is True and os.path.exists(fig):
                src = fig
            dst_rel = f'img/past/{y}_q{n:03d}.jpg'
            im = Image.open(src).convert('L')
            if im.width > 1000:
                im = im.resize((1000, round(im.height * 1000 / im.width)), Image.LANCZOS)
            im.save(os.path.join(repo, dst_rel), quality=72, optimize=True)
            item['img'] = dst_rel
            item['iw'] = round(im.width / 2)  # 表示幅（CSSピクセル）：200dpiの画像を半分の幅で表示すると本文と同程度の文字サイズ
        out.append(item)

js = ('/*\n * IPA公開のITパスポート試験 過去問題（公開問題）\n'
      ' * 出典：独立行政法人情報処理推進機構（IPA） ITパスポート試験 公開問題\n'
      ' * 問題文・選択肢・正解はIPA公開の問題冊子・解答例より。解説は本アプリ独自に作成。\n */\n'
      'window.IPASS_PAST = ' + json.dumps(out, ensure_ascii=False, indent=0) + ';\n')
open(os.path.join(repo, 'js', 'past_questions.js'), 'w', encoding='utf-8').write(js)
print('written', len(out), 'questions')
print('\n'.join(warnings) if warnings else 'no warnings')
