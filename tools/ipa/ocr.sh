#!/bin/sh
# 未処理ページだけOCRする（1プロセス1スレッドで4並列）
cd "$(dirname "$0")"
export OMP_THREAD_LIMIT=1
for f in r06/*.jpg r07/*.jpg r08/*.jpg; do
  if [ -s "$f.ocr.tsv" ] && [ -s "$f.ocr.txt" ]; then continue; fi
  echo "$f"
done | xargs -P 4 -I{} tesseract {} {}.ocr -l jpn --psm 6 txt tsv
echo DONE
ls r06/*.tsv r07/*.tsv r08/*.tsv | wc -l
