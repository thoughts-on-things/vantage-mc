import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

SHOT = Path(os.environ.get("VANTAGE_UI_SCREENSHOT", Path(tempfile.gettempdir()) / "vantage-library.png"))
SETTINGS_SHOT = SHOT.with_name(f"{SHOT.stem}-settings{SHOT.suffix}")
RESET_SHOT = SHOT.with_name(f"{SHOT.stem}-reset-confirmation{SHOT.suffix}")
RENDERS_SHOT = SHOT.with_name(f"{SHOT.stem}-renders{SHOT.suffix}")
SHORTCUTS_SHOT = SHOT.with_name(f"{SHOT.stem}-shortcuts{SHOT.suffix}")

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

    # A world played after its render is flagged, not silently served stale.
    stale_card = page.locator(".world-card", has=page.locator(".ready-badge.stale"))
    assert stale_card.count() == 1
    assert "played since" in stale_card.locator(".ready-badge.stale").inner_text().lower()
    stale_card.click()
    assert page.get_by_role("button", name="Re-render").is_visible()
    assert "played after its render" in page.locator(".detail-note.warn").inner_text()

    # Filters and sorting narrow the grid and are remembered.
    page.get_by_role("button", name="Not rendered", exact=True).click()
    page.wait_for_function("document.querySelectorAll('.world-card:not(.skeleton)').length === 1")
    assert page.locator(".ready-badge").count() == 0
    page.get_by_role("button", name="Rendered", exact=True).click()
    page.wait_for_function("document.querySelectorAll('.world-card:not(.skeleton)').length === 1")
    assert page.locator(".ready-badge").count() == 1
    page.get_by_label("Sort worlds").select_option("name")
    saved_view = page.evaluate("JSON.parse(localStorage.getItem('vantage.desktop.library-view.v1'))")
    assert saved_view == {"sort": "name", "filter": "rendered"}
    page.get_by_role("button", name="All", exact=True).click()
    page.wait_for_function("document.querySelectorAll('.world-card:not(.skeleton)').length === 2")
    assert page.locator(".world-card h3").first.inner_text() == "Copper Hills"
    page.get_by_label("Sort worlds").select_option("recent")
    page.wait_for_function("document.querySelector('.world-card h3').textContent === 'Green Valley'")

    page.get_by_role("button", name="Settings").click()
    page.get_by_role("heading", name="Settings").wait_for()
    assert "logical CPU threads detected" in page.locator(".host-card b").inner_text()
    page.get_by_role("radio").filter(has_text="Maximum").click()
    cave_toggle = page.get_by_text("Cave-ready geometry").locator("xpath=ancestor::label")
    assert cave_toggle.locator("input").is_checked()
    cave_toggle.click()
    assert not cave_toggle.locator("input").is_checked()
    saved = page.evaluate("JSON.parse(localStorage.getItem('vantage.desktop.settings.v1'))")
    assert saved["performanceMode"] == "maximum"
    assert saved["fullCaves"] is False
    page.screenshot(path=str(SETTINGS_SHOT), full_page=True)
    page.keyboard.press("Escape")
    assert page.get_by_role("heading", name="Settings").count() == 0
    assert page.get_by_role("button", name="Settings").evaluate("el => el === document.activeElement")

    # Turning off a geometry setting re-labels every render baked with the old
    # one: opening it now rebuilds, and the badge says so before the click.
    settings_badge = page.locator(".world-card", has=page.locator(".ready-badge.stale"))
    assert "settings changed" in settings_badge.locator(".ready-badge.stale").inner_text().lower()

    # Renders manager: disk accounting, orphan flagging, confirmed deletion.
    page.keyboard.press("Control+2")
    page.get_by_role("heading", name="Your renders").wait_for()
    page.wait_for_function("document.querySelectorAll('.render-row').length === 2")
    assert "MB" in page.locator(".renders-summary b").first.inner_text()
    assert page.locator(".tag.warn").count() == 1
    page.screenshot(path=str(RENDERS_SHOT), full_page=True)
    page.get_by_role("button", name="Delete render of Old Survival").click()
    confirm_delete = page.get_by_role("group", name="Confirm deleting Old Survival")
    confirm_delete.wait_for()
    confirm_delete.get_by_role("button", name="Delete render").click()
    page.wait_for_function("document.querySelectorAll('.render-row').length === 1")

    # The shortcut sheet opens from the keyboard and closes with Escape.
    page.keyboard.press("?")
    page.get_by_role("heading", name="Shortcuts").wait_for()
    page.screenshot(path=str(SHORTCUTS_SHOT), full_page=True)
    page.keyboard.press("Escape")
    assert page.get_by_role("heading", name="Shortcuts").count() == 0
    page.keyboard.press("Control+1")
    page.get_by_role("heading", name="Your worlds").wait_for()

    # Regression: two play clicks in the same event cycle must claim exactly
    # one action and lock every conflicting control before the native call ends.
    first_card = page.locator(".world-card:not(.skeleton)").first
    first_card.click()
    play = page.get_by_role("button", name="Open Green Valley")
    play.evaluate("el => { el.click(); el.click(); }")
    first_card.locator(".card-busy").wait_for()
    assert "rendering" in first_card.locator(".card-busy").inner_text().lower()
    assert page.locator(".card-open:disabled").count() == 2
    assert page.get_by_role("textbox", name="Search worlds").is_disabled()
    assert page.get_by_role("button", name="Scan again").is_disabled()
    assert page.get_by_role("button", name="Cancel render").is_visible()
    page.get_by_role("alert").wait_for(timeout=2_000)
    assert "already rendering" not in page.get_by_role("alert").inner_text().lower()
    assert page.locator(".card-open:disabled").count() == 0
    page.get_by_role("button", name="Dismiss error").click()

    # Cached renders expose safe maintenance actions. Reset requires an inline
    # confirmation and immediately returns the world to its unrendered state.
    cached_card = page.locator(".world-card:not(.skeleton)").nth(1)
    cached_card.click()
    assert page.get_by_role("button", name="Regenerate preview").is_visible()
    page.get_by_role("button", name="Reset render").click()
    confirmation = page.get_by_role("group", name="Confirm render reset")
    confirmation.wait_for()
    assert "original world is never changed" in confirmation.inner_text().lower()
    page.wait_for_timeout(100)
    confirmation.screenshot(path=str(RESET_SHOT))
    confirmation.get_by_role("button", name="Keep render").click()
    assert confirmation.count() == 0
    page.get_by_role("button", name="Reset render").click()
    page.get_by_role("group", name="Confirm render reset").get_by_role("button", name="Reset render").click()
    page.get_by_role("button", name="Render this world").wait_for()
    assert cached_card.locator(".ready-badge").count() == 0

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
    print(f"settings_screenshot={SETTINGS_SHOT}")
    print(f"reset_screenshot={RESET_SHOT}")
    print(f"renders_screenshot={RENDERS_SHOT}")
    print(f"shortcuts_screenshot={SHORTCUTS_SHOT}")
    browser.close()
