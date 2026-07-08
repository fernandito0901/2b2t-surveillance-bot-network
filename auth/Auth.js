/**
 * auth/Auth.js — Dashboard login + role-based access control.
 *
 * Four roles (increasing power): viewer < trusted < admin < owner.
 *   - viewer:  read-only (see the map, bot status, activity).
 *   - trusted: + place/manage bots, manage groups, manage activity.
 *   - admin:   + add/remove Minecraft accounts, force re-login (MFA),
 *              change settings, and manage viewer/trusted/admin dashboard users.
 *   - owner:   + everything admin can, PLUS the sensitive bits an admin is walled
 *              off from: viewing dashboard users' login IPs, granting the owner
 *              role, and seeing / editing / deleting owner accounts at all. To an
 *              admin, owner accounts are invisible and their IP history is withheld.
 *
 * Passwords are scrypt-hashed; sessions are stateless HMAC-signed tokens (so they
 * survive app restarts) carried in an httpOnly cookie. No external dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { systemLogger } = require('../logging/Logger');
const { writeJsonAtomic } = require('../lib/atomicWrite');

const ROLE_LEVEL = { viewer: 0, trusted: 1, admin: 2, owner: 3 };
const USERS_FILE = path.resolve('./data/users.json');
const SECRET_FILE = path.resolve('./data/.session_secret');
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class Auth {
  constructor() {
    this.users = this._loadUsers();
    this.secret = this._loadSecret();
    // A precomputed valid hash to verify against when a username doesn't exist, so
    // authenticate() spends the same scrypt time either way (no enumeration oracle).
    this._dummyHash = this._hash(crypto.randomBytes(16).toString('hex'));
    this._migrateOwners();
    this._bootstrapOwner();
    this._warnDefaultAdmin();
  }

  static get COOKIE() { return 'sid'; }
  level(role) { return ROLE_LEVEL[role] != null ? ROLE_LEVEL[role] : -1; }
  isRole(role) { return ROLE_LEVEL[role] != null; }
  roles() { return Object.keys(ROLE_LEVEL); }
  /** True if the role can act on / see owner accounts + login IPs (owner only). */
  isOwner(role) { return role === 'owner'; }

  /** One-time upgrade for the owner/admin split: before it, the top role was
   *  'admin'. If nobody is an owner yet but admins exist, promote them so the
   *  existing operator keeps full power as owner and 'admin' becomes the new
   *  restricted tier. Idempotent — never runs once an owner exists. */
  _migrateOwners() {
    if (this.users.some(u => u.role === 'owner')) return;
    const admins = this.users.filter(u => u.role === 'admin');
    if (!admins.length) return;
    for (const u of admins) u.role = 'owner';
    this._saveUsers();
    systemLogger.info(`Auth: migrated ${admins.length} admin account(s) to owner (owner/admin split)`);
  }

  // ── persistence ───────────────────────────────────────────
  _loadUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { return []; }
  }
  _saveUsers() {
    try { writeJsonAtomic(USERS_FILE, this.users); }
    catch (e) { systemLogger.error('Failed to save users:', e.message); }
  }
  _loadSecret() {
    try { return fs.readFileSync(SECRET_FILE, 'utf8'); }
    catch (e) {
      const s = crypto.randomBytes(48).toString('hex');
      try { fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); } catch (e2) {}
      return s;
    }
  }

  /** Create an initial owner if there are no users yet. */
  _bootstrapOwner() {
    if (this.users.length) return;
    const username = (process.env.ADMIN_USER || 'owner').toLowerCase();
    const password = process.env.ADMIN_PASSWORD ||
      crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
    this.users.push({ username, password: this._hash(password), role: 'owner', createdAt: Date.now() });
    this._saveUsers();
    systemLogger.warn('══════════════════════════════════════════════════════════════');
    systemLogger.warn(`  Created initial OWNER user "${username}" with password: ${password}`);
    systemLogger.warn('  Log in, change it, and add users via the Admin tab.');
    systemLogger.warn('══════════════════════════════════════════════════════════════');
  }

  /** Startup warning: a guessable default top-level name ('owner'/'admin') is a
   *  known brute-force target. If the only owner still uses one, nudge a rename. */
  _warnDefaultAdmin() {
    const owners = this.users.filter(u => u.role === 'owner');
    if (owners.length === 1 && (owners[0].username === 'owner' || owners[0].username === 'admin')) {
      systemLogger.warn(`Security: the only owner uses the default name "${owners[0].username}" — add a differently-named owner and remove this one to reduce brute-force exposure.`);
    }
  }

  // ── password hashing (scrypt) ─────────────────────────────
  _hash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `${salt}$${hash}`;
  }
  _verifyHash(password, stored) {
    const [salt, hash] = String(stored).split('$');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ── user management ───────────────────────────────────────
  /**
   * List dashboard users FOR a requesting role. Owners see everyone plus full login
   * history + IPs. Anyone below owner (i.e. admin) gets the restricted view: owner
   * accounts are omitted entirely, and per-user login IPs / last-IP are withheld.
   * @param {string} [actorRole] role of the requester ('owner' unlocks IPs + owners)
   */
  listUsers(actorRole) {
    const asOwner = this.isOwner(actorRole);
    return this.users
      .filter(u => asOwner || u.role !== 'owner') // owner accounts invisible to admins
      .map(u => {
        const base = { username: u.username, role: u.role, createdAt: u.createdAt };
        if (!asOwner) return base;                 // admins never receive IP history
        return {
          ...base,
          lastLogin: u.lastLogin || null, lastIp: u.lastIp || null,
          ips: Object.entries(u.ips || {})
            .map(([ip, m]) => ({ ip, count: m.count, first: m.first, last: m.last }))
            .sort((a, b) => (b.last || 0) - (a.last || 0)),
        };
      });
  }

  /** Guard: an actor may only act on a target account, or grant a role, they have
   *  the standing for. Only an owner may touch owner accounts or grant 'owner'. */
  _assertCanManage(actorRole, { targetRole, grantRole } = {}) {
    if (this.isOwner(actorRole)) return; // owner can do anything below
    if (targetRole === 'owner') throw new Error('Only an owner can manage owner accounts');
    if (grantRole === 'owner') throw new Error('Only an owner can grant the owner role');
  }

  addUser(username, password, role = 'viewer', actorRole = 'owner') {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(username)) throw new Error('Username must be 2-32 chars (a-z, 0-9, _ . -)');
    if (!password || String(password).length < 12) throw new Error('Password must be at least 12 characters');
    if (!this.isRole(role)) throw new Error('Invalid role');
    this._assertCanManage(actorRole, { grantRole: role });
    if (this.users.some(u => u.username === username)) throw new Error('User already exists');
    this.users.push({ username, password: this._hash(password), role, createdAt: Date.now() });
    this._saveUsers();
    return { username, role };
  }
  removeUser(username, actorRole = 'owner') {
    username = String(username || '').toLowerCase();
    const u = this.users.find(x => x.username === username);
    if (!u) throw new Error('Unknown user');
    this._assertCanManage(actorRole, { targetRole: u.role });
    // Never let the last owner be removed (the top tier must never be locked out).
    if (u.role === 'owner' && this.users.filter(x => x.role === 'owner').length <= 1) {
      throw new Error('Cannot remove the last owner');
    }
    this.users = this.users.filter(x => x.username !== username);
    this._saveUsers();
    return true;
  }
  updateUser(username, { role, password }, actorRole = 'owner') {
    username = String(username || '').toLowerCase();
    const u = this.users.find(x => x.username === username);
    if (!u) throw new Error('Unknown user');
    // Standing to touch THIS account at all (its current role), and to grant the
    // requested role — an admin can neither edit an owner nor promote anyone to owner.
    this._assertCanManage(actorRole, { targetRole: u.role, grantRole: role });
    if (role !== undefined) {
      if (!this.isRole(role)) throw new Error('Invalid role');
      // Never let the last owner be demoted.
      if (u.role === 'owner' && role !== 'owner' && this.users.filter(x => x.role === 'owner').length <= 1) {
        throw new Error('Cannot demote the last owner');
      }
      u.role = role;
    }
    if (password !== undefined) {
      if (String(password).length < 12) throw new Error('Password must be at least 12 characters');
      u.password = this._hash(password);
      u.tokenEpoch = (u.tokenEpoch || 0) + 1; // log out existing sessions
    }
    this._saveUsers();
    return { username: u.username, role: u.role };
  }

  // ── login + sessions ──────────────────────────────────────
  authenticate(username, password) {
    username = String(username || '').trim().toLowerCase();
    const u = this.users.find(x => x.username === username);
    if (!u) {
      // Unknown user: still run a scrypt against a dummy hash so the response time
      // doesn't reveal whether the username exists (enumeration side-channel).
      this._verifyHash(password, this._dummyHash);
      return null;
    }
    if (!this._verifyHash(password, u.password)) return null;
    return { username: u.username, role: u.role };
  }

  /** Invalidate every outstanding token for a user by bumping their tokenEpoch —
   *  verifyToken rejects any token whose epoch no longer matches. Used by logout
   *  for real server-side revocation (a cleared cookie alone leaves the stateless
   *  7-day token valid). Returns true if the user existed. */
  bumpTokenEpoch(username) {
    username = String(username || '').toLowerCase();
    const u = this.users.find(x => x.username === username);
    if (!u) return false;
    u.tokenEpoch = (u.tokenEpoch || 0) + 1;
    this._saveUsers();
    return true;
  }

  // ── IP logging (spot shared accounts) ─────────────────────
  /** Record a successful login from an IP (increments that IP's count). */
  recordLogin(username, ip) { this._noteIp(username, ip, true); }
  /** Note an IP on an authenticated request — persists only NEW IPs (so we catch
   *  cookie-sharing too) without a disk write on every request. */
  touchIp(username, ip) { this._noteIp(username, ip, false); }
  _noteIp(username, ip, isLogin) {
    const u = this.users.find(x => x.username === username);
    if (!u) return;
    ip = String(ip || 'unknown').replace(/^::ffff:/, ''); // normalise IPv4-mapped IPv6
    u.ips = u.ips || {};
    const known = !!u.ips[ip];
    if (!known) u.ips[ip] = { count: 0, first: Date.now(), last: 0 };
    if (isLogin || !known) {
      u.ips[ip].count++;
      u.ips[ip].last = Date.now();
      if (isLogin) { u.lastLogin = Date.now(); u.lastIp = ip; }
      const entries = Object.entries(u.ips);
      if (entries.length > 40) { entries.sort((a, b) => b[1].last - a[1].last); u.ips = Object.fromEntries(entries.slice(0, 40)); }
      this._saveUsers();
    } else {
      u.ips[ip].last = Date.now(); // in-memory only; flushed on the next login/new-IP
    }
  }

  createToken(user) {
    const u = this.users.find(x => x.username === user.username);
    const payload = Buffer.from(JSON.stringify({ u: user.username, e: (u && u.tokenEpoch) || 0, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }
  /** Validate a session token → current {username, role} or null. */
  verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const expect = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(sig || ''), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!data.exp || data.exp < Date.now()) return null;
      const u = this.users.find(x => x.username === data.u); // re-read role live
      if (!u || ((u.tokenEpoch || 0) !== (data.e || 0))) return null; // password changed → revoked
      return { username: u.username, role: u.role };
    } catch (e) { return null; }
  }
}

module.exports = new Auth();
