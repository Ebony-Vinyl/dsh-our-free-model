"""Browser acceptance for the plugin center.

Starts the real standalone service against a signed fixture market, drives the
console with Playwright/Edge, and writes screenshots under `.verify/`.

Run: python scripts/plugins-e2e.py
"""
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright, expect


ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / '.verify' / f'plugins-{datetime.datetime.now():%Y%m%d-%H%M%S}'
OUT.mkdir(parents=True, exist_ok=True)

node = shutil.which('node')
if node is None:
    raise SystemExit('node is not on PATH')

server = subprocess.Popen(
    [node, str(ROOT / 'scripts' / 'lib' / 'plugin-e2e-server.mjs')],
    cwd=str(ROOT),
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding='utf-8',
)
line = server.stdout.readline()
if not line:
    print(server.stderr.read(), file=sys.stderr)
    raise SystemExit('the fixture service did not announce itself')
info = json.loads(line)
print('fixture service:', info['managementUrl'])

local_dir = OUT / 'local-plugin'
(local_dir / 'ui').mkdir(parents=True, exist_ok=True)
(local_dir / 'ofm-plugin.json').write_text(json.dumps({
    'schemaVersion': 2,
    'id': 'fixture-local',
    'version': '1.0.0',
    'kind': 'page',
    'apiVersion': '^2',
    'name': 'Local Page',
    'files': ['ui/index.html'],
    'permissions': {'network': [], 'secrets': [], 'storage': False},
    'contributes': {
        'pages': [{'id': 'local', 'title': 'Local Page', 'entry': 'ui/index.html', 'group': '工具', 'order': 60, 'icon': 'tool'}],
    },
}, ensure_ascii=False), encoding='utf-8')
(local_dir / 'ui' / 'index.html').write_text(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>'
    '<body><h1 id="local">local page</h1></body></html>',
    encoding='utf-8',
)


def screenshot(page, name):
    page.screenshot(path=str(OUT / name), full_page=True)
    print('screenshot', OUT / name)


def card(page, name):
    return page.locator('.plugin-card').filter(has_text=name)


try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, channel='msedge')
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='zh-CN')
        page = context.new_page()
        page.set_default_timeout(30_000)
        page.goto(info['managementUrl'], wait_until='networkidle')
        page.wait_for_selector('#app', timeout=30_000)
        # The first visit opens the disclaimer once; acknowledge it before the
        # sidebar is clickable.
        try:
            page.get_by_role('button', name='我已阅读并了解').click(timeout=8_000)
        except Exception:
            pass
        # The sponsor notice opens once per day on first visit; collapse it.
        try:
            page.locator('.ofm-sponsor-close').click(timeout=8_000)
        except Exception:
            pass
        page.wait_for_timeout(300)
        screenshot(page, '01-console.png')

        page.locator('.console-nav-item', has_text='插件中心').click()
        page.wait_for_selector('[data-testid="plugins-page"]')
        screenshot(page, '02-plugin-center.png')

        # ── install a signed page plugin from the fixture market ────────────
        page.get_by_role('tab', name=re.compile('已安装')).click()
        page.get_by_role('tab', name='发现').click()
        page.locator('.plugin-card', has_text='Fixture Page').get_by_role('button', name='安装').click()
        page.get_by_role('button', name='确认安装').click()
        expect(page.locator('.plugin-card', has_text='Fixture Page').get_by_text('已安装')).to_be_visible(timeout=30_000)
        screenshot(page, '03-page-installed.png')

        # The sidebar learns the page from the refreshed summary.
        sidebar_page = page.locator('.console-nav-item', has_text='Demo Page')
        expect(sidebar_page).to_be_visible(timeout=15_000)
        sidebar_page.click()
        page.wait_for_selector('[data-testid="plugin-page"] iframe')
        frame = page.frame_locator('[data-testid="plugin-page"] iframe')
        expect(frame.locator('#title')).to_have_text('Hello', timeout=15_000)
        expect(frame.locator('#visits')).to_have_text('visits=1')
        expect(page.locator('.notice', has_text='page-ready')).to_be_visible()
        screenshot(page, '04-page-rendered.png')

        page.locator('.theme-toggle').click()
        page.wait_for_timeout(700)
        theme = frame.locator('html').evaluate("el => el.dataset.theme")
        assert theme == 'dark', f'page did not receive the dark theme: {theme}'
        screenshot(page, '05-page-dark.png')

        # ── disable and uninstall the page ─────────────────────────────────
        page.locator('.console-nav-item', has_text='插件中心').click()
        page.get_by_role('tab', name=re.compile('已安装')).click()
        page.locator('.plugin-card', has_text='Fixture Page').get_by_role('button', name='停用').click()
        expect(page.locator('.console-nav-item', has_text='Demo Page')).to_have_count(0, timeout=15_000)
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('.plugin-card', has_text='Fixture Page').get_by_role('button', name='卸载').click()
        expect(page.locator('.plugin-card', has_text='Fixture Page')).to_have_count(0, timeout=15_000)

        # ── install a channel plugin and prove the catalog row ─────────────
        page.get_by_role('tab', name='发现').click()
        page.locator('.plugin-card', has_text='Fixture Channel').get_by_role('button', name='安装').click()
        page.get_by_role('button', name='确认安装').click()
        expect(page.locator('.plugin-card', has_text='Fixture Channel').get_by_text('已安装')).to_be_visible(timeout=30_000)
        catalog = page.evaluate("""async () => {
            const response = await fetch('/api/management/summary')
            const value = await response.json()
            return value.catalog.map(row => row.id)
        }""")
        assert 'ext:fixture-channel/demo-model' in catalog, catalog
        screenshot(page, '06-channel-installed.png')

        # ── developer mode installs an unsigned local page ─────────────────
        page.get_by_role('tab', name=re.compile('已安装')).click()
        page.locator('.plugin-switch input').click()
        page.wait_for_selector('.plugin-developer-form')
        page.locator('.plugin-developer-form input[type="text"]').fill(str(local_dir))
        page.locator('.plugin-check input').click()
        page.get_by_role('button', name='安装本地插件').click()
        expect(page.locator('.plugin-card', has_text='Local Page')).to_be_visible(timeout=30_000)
        expect(page.locator('.plugin-card', has_text='Local Page').get_by_text('未验证')).to_be_visible()
        screenshot(page, '07-developer-installed.png')
        expect(page.locator('.console-nav-item', has_text='Local Page')).to_be_visible(timeout=15_000)
        page.locator('.console-nav-item', has_text='Local Page').click()
        page.wait_for_selector('[data-testid="plugin-page"] iframe')
        expect(page.frame_locator('[data-testid="plugin-page"] iframe').locator('#local')).to_have_text('local page')
        screenshot(page, '08-developer-page.png')

        context.close()
        browser.close()
        print('E2E PASSED', OUT)
except Exception as error:
    print('E2E FAILED:', error, file=sys.stderr)
    raise
finally:
    try:
        server.stdin.write('close\n')
        server.stdin.flush()
    except Exception:
        pass
    try:
        server.wait(timeout=30)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=10)
