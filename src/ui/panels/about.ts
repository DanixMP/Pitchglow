// About panel (top bar, right): the author's GitHub profile, the project's purpose, how it works,
// privacy and license, in a side sheet (<dialog>: Esc or a click outside closes it).
// Privacy first: the GitHub details (avatar, name, bio, counts) are fetched only when the visitor
// clicks "Load from GitHub", then kept on this device (the avatar as a small data URL, so it never
// has to be fetched again) until "Forget". The service worker doesn't touch other origins.

import { $, $$ } from '../dom';

declare const __APP_VERSION__: string;

const GITHUB_USER = 'DanixMP';
const STORE_KEY = 'recorder.githubProfile';

interface Profile {
  login: string;
  name: string | null;
  bio: string | null;
  location: string | null;
  blog: string | null;
  publicRepos: number;
  followers: number;
  following: number;
  createdAt: string;
  /** data: URL of the avatar (kept locally), or null. */
  avatar: string | null;
  fetchedAt: number;
}

function loadSaved(): Profile | null {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Profile | null;
    return p && p.login ? p : null;
  } catch {
    return null;
  }
}

function save(p: Profile | null): void {
  try {
    if (p) localStorage.setItem(STORE_KEY, JSON.stringify(p));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage unavailable: the details just won't be remembered.
  }
}

async function fetchProfile(): Promise<Profile> {
  const res = await fetch(`https://api.github.com/users/${GITHUB_USER}`, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests right now; try again later.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const u = (await res.json()) as {
    login: string;
    name: string | null;
    bio: string | null;
    location: string | null;
    blog: string | null;
    public_repos: number;
    followers: number;
    following: number;
    created_at: string;
    avatar_url: string;
  };
  let avatar: string | null = null;
  try {
    const img = await fetch(`${u.avatar_url}${u.avatar_url.includes('?') ? '&' : '?'}s=160`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    const blob = await img.blob();
    avatar = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    avatar = null; // the details are still worth showing
  }
  return {
    login: u.login,
    name: u.name,
    bio: u.bio,
    location: u.location,
    blog: u.blog,
    publicRepos: u.public_repos,
    followers: u.followers,
    following: u.following,
    createdAt: u.created_at,
    avatar,
    fetchedAt: Date.now(),
  };
}

export function mountAbout(): void {
  const dialog = $<HTMLDialogElement>('about');
  const open = $<HTMLButtonElement>('about-open');
  const close = $<HTMLButtonElement>('about-close');
  const tabs = $$<HTMLButtonElement>('.about-tab');
  const load = $<HTMLButtonElement>('profile-load');
  const forget = $<HTMLButtonElement>('profile-forget');
  const status = $('profile-status');
  $('about-version').textContent = `v${__APP_VERSION__}`;

  const showTab = (name: string) => {
    for (const t of tabs) {
      const on = t.dataset.aboutTab === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')!).hidden = !on;
    }
    if (name === 'privacy') void showStorage();
  };
  for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.aboutTab!));
  // Arrow keys move between tabs (tablist pattern).
  $('about').querySelector('.about-tabs')!.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.classList.contains('is-on'));
    const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.aboutTab!);
    next.focus();
    ev.preventDefault();
  });

  open.addEventListener('click', () => {
    dialog.showModal();
    tabs.find((t) => t.classList.contains('is-on'))?.focus();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });

  const render = (p: Profile | null) => {
    const initial = (p?.name || p?.login || GITHUB_USER).trim().charAt(0).toUpperCase();
    for (const id of ['profile-avatar', 'about-avatar']) {
      const el = $(id);
      el.textContent = p?.avatar ? '' : initial;
      el.style.backgroundImage = p?.avatar ? `url("${p.avatar}")` : '';
      el.classList.toggle('has-image', !!p?.avatar);
    }
    $('profile-name').textContent = p?.name || p?.login || GITHUB_USER;
    const bio = $('profile-bio');
    bio.hidden = !p?.bio;
    bio.textContent = p?.bio ?? '';
    $('profile-stats').hidden = !p;
    if (p) {
      $('profile-repos').textContent = String(p.publicRepos);
      $('profile-followers').textContent = String(p.followers);
      $('profile-following').textContent = String(p.following);
      $('profile-since').textContent = new Date(p.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    }
    const extra = $('profile-extra');
    const bits = [p?.location, p?.blog].filter(Boolean) as string[];
    extra.hidden = !bits.length;
    extra.textContent = bits.join(' · ');
    load.textContent = p ? 'Refresh from GitHub' : 'Load from GitHub';
    forget.hidden = !p;
    status.textContent = p ? `Loaded ${new Date(p.fetchedAt).toLocaleDateString()}; kept on this device.` : '';
  };

  load.addEventListener('click', async () => {
    load.disabled = true;
    status.textContent = 'Asking GitHub…';
    try {
      const p = await fetchProfile();
      save(p);
      render(p);
    } catch (err) {
      status.textContent = err instanceof Error && err.message.startsWith('GitHub') ? err.message : 'Couldn’t reach GitHub (offline?).';
    } finally {
      load.disabled = false;
    }
  });
  forget.addEventListener('click', () => {
    save(null);
    render(null);
    status.textContent = 'Forgotten.';
  });

  async function showStorage(): Promise<void> {
    const el = $('about-storage');
    try {
      const est = await navigator.storage?.estimate?.();
      if (!est?.usage) throw new Error();
      const mb = est.usage / (1024 * 1024);
      const persisted = (await navigator.storage.persisted?.()) ? ', protected from automatic clean-up' : '';
      el.textContent = `This device holds ${mb < 1 ? `${Math.max(1, Math.round(est.usage / 1024))} KB` : `${mb.toFixed(1)} MB`} of PitchGlow data${persisted}.`;
    } catch {
      el.textContent = 'Your takes and songs are stored in this browser only.';
    }
  }

  render(loadSaved());
}
