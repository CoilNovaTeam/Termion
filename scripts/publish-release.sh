#!/usr/bin/env bash
# Выкладывает собранные exe в GitHub Releases. Вызывается из .github/workflows/release.yml:
#   publish-release.sh <тег> <версия>
# Нужны gh и GH_TOKEN. Если релиз с этим тегом уже есть (перезапуск сборки) — файлы заменяются.
# DRY_RUN=1 — только проверить файлы и показать текст релиза.

set -euo pipefail

tag=${1:?тег}
version=${2:?версия}
files=("dist/Termion-Setup-$version.exe" "dist/Termion-$version-portable.exe")

for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "Нет файла $f" >&2; exit 1; }
done

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
sed "s/@VERSION@/$version/g" > "$notes" <<'EOF'
## Скачать

- **Termion-Setup-@VERSION@.exe** — установщик, рекомендуется. Ставится в один щелчок без прав администратора, создаёт ярлык на рабочем столе и в меню «Пуск». Новая версия ставится поверх старой; сессии, пароли и настройки сохраняются.
- **Termion-@VERSION@-portable.exe** — без установки, например для флешки. При каждом запуске распаковывается во временную папку, поэтому открывается секунд 8–10.

Программа не подписана сертификатом, поэтому при первом запуске Windows может показать «Система Windows защитила ваш компьютер». Нажмите «Подробнее» → «Выполнить в любом случае».

Сессии, пароли и настройки хранятся в `%APPDATA%\Termion` — общие для обоих вариантов.
EOF

if [ "${DRY_RUN:-}" = 1 ]; then
  ls -l "${files[@]}"
  cat "$notes"
  exit 0
fi

if gh release view "$tag" > /dev/null 2>&1; then
  gh release upload "$tag" "${files[@]}" --clobber
else
  gh release create "$tag" "${files[@]}" --title "Termion $version" --notes-file "$notes" --generate-notes
fi
