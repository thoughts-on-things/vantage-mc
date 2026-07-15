import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

SHOT = Path(os.environ.get("VANTAGE_UI_SCREENSHOT", Path(tempfile.gettempdir()) / "vantage-library.png"))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    errors: list[str] = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto("http://127.0.0.1:1420")
    page.wait_for_load_state("networkidle")
    page.get_by_role("heading", name="Your worlds").wait_for()
    assert page.locator(".world-card:not(.skeleton)").count() == 2

    page.keyboard.press("Control+k")
    search = page.get_by_role("textbox", name="Search worlds")
    assert search.evaluate("el => el === document.activeElement")
    first_world = page.locator(".world-card h3").first.inner_text()
    search.fill(first_world.split()[0])
    page.wait_for_function("document.querySelectorAll('.world-card:not(.skeleton)').length === 1")
    assert page.locator(".world-card:not(.skeleton)").count() == 1
    search.press("Escape")
    page.wait_for_function("document.querySelectorAll('.world-card:not(.skeleton)').length === 2")
    assert page.locator(".world-card:not(.skeleton)").count() == 2

    page.locator(".world-card:not(.skeleton)").first.click()
    assert page.get_by_text("Selected world").is_visible()
    selected_before = page.locator(".world-detail h2").inner_text()
    page.keyboard.press("ArrowRight")
    selected_after = page.locator(".world-detail h2").inner_text()
    assert selected_before != selected_after

    page.emulate_media(reduced_motion="reduce")
    reduced_duration = page.locator(".world-card").first.evaluate("el => getComputedStyle(el).animationDuration")
    assert reduced_duration in {"0.001ms", "1e-06s"}
    page.screenshot(path=str(SHOT), full_page=True)
    fonts = page.evaluate("performance.getEntriesByType('resource').map(e => e.name).filter(name => name.endsWith('.woff2')).length")
    print(f"title={page.title()!r}")
    print(f"world_cards={page.locator('.world-card:not(.skeleton)').count()}")
    print(f"loaded_fonts={fonts}")
    print(f"reduced_motion_duration={reduced_duration}")
    print(f"console_errors={errors}")
    print(f"screenshot={SHOT}")
    browser.close()
