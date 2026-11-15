// The toolbar wraps at narrower widths. Popovers belong below its last row
// so they cannot intercept a click on another toolbar control.
let active = null;
let bound = false;

export function closeToolbarPopover() {
    if (!active) return;
    const {pop, trigger, onClose} = active;
    active = null;
    pop.style.display = 'none';
    trigger.setAttribute('aria-expanded', 'false');
    if (onClose) onClose();
}

function positionPopover() {
    if (!active) return;
    const {trigger, pop} = active;
    const anchor = pop.offsetParent;
    const toolbar = trigger.closest('.nt-topbar');
    const root = trigger.closest('#nt-root');
    if (!anchor || !toolbar || !root) {
        closeToolbarPopover();
        return;
    }
    const bounds = root.getBoundingClientRect();
    const left = Math.max(0, bounds.left) + 6;
    const right = Math.min(window.innerWidth, bounds.right) - 6;
    const top = toolbar.getBoundingClientRect().bottom + 4;
    pop.style.top = (top - anchor.getBoundingClientRect().top) + 'px';
    pop.style.maxHeight = Math.max(0, Math.min(window.innerHeight, bounds.bottom) - top - 6) + 'px';
    pop.style.maxWidth = Math.max(0, right - left) + 'px';
    pop.style.right = '0';
    const rect = pop.getBoundingClientRect();
    pop.style.right = (Math.max(0, rect.right - right) - Math.max(0, left - rect.left)) + 'px';
}

function bindPopoverEvents(toolbar) {
    if (bound) return;
    bound = true;
    document.addEventListener('click', function(e) {
        if (active && !active.pop.contains(e.target) && !active.trigger.contains(e.target)) {
            closeToolbarPopover();
        }
    });
    document.addEventListener('fullscreenchange', positionPopover);
    document.addEventListener('webkitfullscreenchange', positionPopover);
    window.addEventListener('resize', positionPopover);
    if (toolbar && window.ResizeObserver) {
        new window.ResizeObserver(positionPopover).observe(toolbar);
    }
}

export function toggleToolbarPopover(trigger, pop, onClose) {
    const wasOpen = active && active.pop === pop;
    closeToolbarPopover();
    if (wasOpen) return;
    bindPopoverEvents(trigger.closest('.nt-topbar'));
    pop.style.marginTop = '0';
    pop.style.boxSizing = 'border-box';
    pop.style.overflow = 'auto';
    pop.style.overscrollBehavior = 'contain';
    pop.style.display = 'block';
    trigger.setAttribute('aria-expanded', 'true');
    active = {trigger, pop, onClose};
    positionPopover();
}
