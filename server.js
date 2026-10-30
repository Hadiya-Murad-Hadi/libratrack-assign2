const express = require("express"),
  mysql = require("mysql2/promise"),
  bcrypt = require("bcryptjs"),
  jwt = require("jsonwebtoken"),
  fs = require("fs"),
  path = require("path");
const E = process.env,
  SECRET = E.JWT_SECRET || "change-me-in-production";
const FINE_PER_DAY = 10,
  LOAN_DAYS = 14,
  MAX_LOANS = 3;
// Works with plain DB_* vars (EC2) and Elastic Beanstalk's RDS_* vars.
const cfg = {
  host: E.DB_HOST || E.RDS_HOSTNAME || "localhost",
  port: +(E.DB_PORT || E.RDS_PORT || 3306),
  user: E.DB_USER || E.RDS_USERNAME || "root",
  password: E.DB_PASSWORD || E.RDS_PASSWORD || "",
  database: E.DB_NAME || E.RDS_DB_NAME || "libratrack",
};
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
let pool,
  ready = false;

async function init() {
  const { database, ...noDb } = cfg;
  const c = await mysql.createConnection(noDb);
  await c.query("CREATE DATABASE IF NOT EXISTS `" + database + "`");
  await c.end();
  pool = mysql.createPool({
    ...cfg,
    multipleStatements: true,
    connectionLimit: 10,
  });
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  const [[a]] = await pool.query(
    "SELECT COUNT(*) n FROM users WHERE role='admin'",
  );
  if (!a.n)
    await pool.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES('Librarian',?,?,'admin')",
      ["admin@libratrack.com", await bcrypt.hash("Admin@123", 10)],
    );
  const [[b]] = await pool.query("SELECT COUNT(*) n FROM books");
  if (!b.n)
    await pool.query(
      "INSERT INTO books(title,author,isbn,copies_total,copies_available) VALUES ?",
      [
        [
          ["Clean Code", "Robert C. Martin", "9780132350884", 3, 3],
          ["The Pragmatic Programmer", "Andrew Hunt", "9780135957059", 2, 2],
          [
            "Designing Data-Intensive Applications",
            "Martin Kleppmann",
            "9781449373320",
            2,
            2,
          ],
          ["The Phoenix Project", "Gene Kim", "9781942788294", 1, 1],
        ],
      ],
    );
  ready = true;
  console.log("Database ready at", cfg.host + ":" + cfg.port);
}
(function boot() {
  init().catch((e) => {
    console.error("DB init failed, retrying:", e.message);
    setTimeout(boot, 5000);
  });
})();

const wrap = (f) => (req, res) =>
  f(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  });
const auth = (role) => (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || "").slice(7), SECRET);
  } catch {
    return res.status(401).json({ error: "Please log in" });
  }
  if (role && req.user.role !== role)
    return res.status(403).json({ error: "Admin access required" });
  next();
};
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const sign = (u) =>
  jwt.sign({ id: u.id, name: u.name, role: u.role }, SECRET, {
    expiresIn: "8h",
  });

app.get(
  "/api/health",
  wrap(async (req, res) => {
    if (!ready) return bad(res, "Database not ready", 503);
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: cfg.host });
  }),
);
app.use("/api", (req, res, next) =>
  ready ? next() : bad(res, "Database not ready", 503),
);

// ---- Module 1: Authentication ----
app.post(
  "/api/register",
  wrap(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !/^\S+@\S+\.\S+$/.test(email || ""))
      return bad(res, "Valid name and email are required");
    if (!password || password.length < 6)
      return bad(res, "Password must be at least 6 characters");
    const [[dup]] = await pool.query("SELECT id FROM users WHERE email=?", [
      email,
    ]);
    if (dup) return bad(res, "Email already registered", 409);
    const [r] = await pool.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'member')",
      [name.trim(), email.toLowerCase(), await bcrypt.hash(password, 10)],
    );
    const u = { id: r.insertId, name: name.trim(), role: "member" };
    res.status(201).json({ token: sign(u), user: u });
  }),
);
app.post(
  "/api/login",
  wrap(async (req, res) => {
    const [[u]] = await pool.query("SELECT * FROM users WHERE email=?", [
      (req.body.email || "").toLowerCase(),
    ]);
    if (!u || !(await bcrypt.compare(req.body.password || "", u.password_hash)))
      return bad(res, "Wrong email or password", 401);
    res.json({
      token: sign(u),
      user: { id: u.id, name: u.name, role: u.role },
    });
  }),
);
app.get("/api/me", auth(), (req, res) => res.json(req.user));
app.get(
  "/api/members",
  auth("admin"),
  wrap(async (req, res) =>
    res.json(
      (
        await pool.query(
          "SELECT id,name,email FROM users WHERE role='member' ORDER BY name",
        )
      )[0],
    ),
  ),
);

// ---- Module 2: Book catalog ----
app.get(
  "/api/books",
  wrap(async (req, res) => {
    const q = "%" + (req.query.q || "") + "%";
    res.json(
      (
        await pool.query(
          "SELECT * FROM books WHERE title LIKE ? OR author LIKE ? OR isbn LIKE ? ORDER BY title",
          [q, q, q],
        )
      )[0],
    );
  }),
);
app.post(
  "/api/books",
  auth("admin"),
  wrap(async (req, res) => {
    const { title, author, isbn } = req.body,
      n = parseInt(req.body.copies, 10);
    if (!title || !author || !isbn)
      return bad(res, "Title, author and ISBN are required");
    if (!(n >= 1)) return bad(res, "Copies must be at least 1");
    try {
      const [r] = await pool.query(
        "INSERT INTO books(title,author,isbn,copies_total,copies_available) VALUES(?,?,?,?,?)",
        [title, author, isbn, n, n],
      );
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY")
        return bad(res, "ISBN already exists", 409);
      throw e;
    }
  }),
);
app.put(
  "/api/books/:id",
  auth("admin"),
  wrap(async (req, res) => {
    const [[b]] = await pool.query("SELECT * FROM books WHERE id=?", [
      req.params.id,
    ]);
    if (!b) return bad(res, "Book not found", 404);
    const t = parseInt(req.body.copies_total ?? b.copies_total, 10),
      avail = b.copies_available + (t - b.copies_total);
    if (!(t >= 1) || avail < 0)
      return bad(
        res,
        "Total copies cannot drop below the number currently issued",
      );
    await pool.query(
      "UPDATE books SET title=?,author=?,copies_total=?,copies_available=? WHERE id=?",
      [req.body.title || b.title, req.body.author || b.author, t, avail, b.id],
    );
    res.json({ ok: true });
  }),
);
app.delete(
  "/api/books/:id",
  auth("admin"),
  wrap(async (req, res) => {
    const [[a]] = await pool.query(
      "SELECT COUNT(*) n FROM issues WHERE book_id=? AND returned_at IS NULL",
      [req.params.id],
    );
    if (a.n)
      return bad(res, "Book has active loans and cannot be deleted", 409);
    await pool.query("DELETE FROM issues WHERE book_id=?", [req.params.id]);
    const [r] = await pool.query("DELETE FROM books WHERE id=?", [
      req.params.id,
    ]);
    r.affectedRows ? res.json({ ok: true }) : bad(res, "Book not found", 404);
  }),
);

// ---- Module 3: Issue / return with fines ----
const FINE_SQL = `IF(i.returned_at IS NULL, GREATEST(DATEDIFF(NOW(), i.due_date),0)*${FINE_PER_DAY}, i.fine)`;
app.get(
  "/api/issues",
  auth(),
  wrap(async (req, res) => {
    const admin = req.user.role === "admin";
    const [rows] = await pool.query(
      `SELECT i.id,i.user_id,u.name AS member,b.title,i.issued_at,i.due_date,i.returned_at,${FINE_SQL} fine
    FROM issues i JOIN users u ON u.id=i.user_id JOIN books b ON b.id=i.book_id ${admin ? "" : "WHERE i.user_id=?"} ORDER BY i.id DESC`,
      [req.user.id],
    );
    res.json(rows);
  }),
);
app.post(
  "/api/issues",
  auth(),
  wrap(async (req, res) => {
    const admin = req.user.role === "admin",
      uid = admin && req.body.user_id ? +req.body.user_id : req.user.id;
    const days =
      admin && req.body.loan_days !== undefined
        ? parseInt(req.body.loan_days, 10)
        : LOAN_DAYS;
    if (isNaN(days) || days < -60 || days > 60)
      return bad(res, "Invalid loan period");
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[b]] = await c.query("SELECT * FROM books WHERE id=? FOR UPDATE", [
        req.body.book_id,
      ]);
      if (!b) {
        await c.rollback();
        return bad(res, "Book not found", 404);
      }
      if (b.copies_available < 1) {
        await c.rollback();
        return bad(res, "No copies available", 409);
      }
      const [[u]] = await c.query("SELECT id FROM users WHERE id=?", [uid]);
      if (!u) {
        await c.rollback();
        return bad(res, "Member not found", 404);
      }
      const [[l]] = await c.query(
        "SELECT COUNT(*) n, SUM(book_id=?) same FROM issues WHERE user_id=? AND returned_at IS NULL",
        [b.id, uid],
      );
      if (l.same > 0) {
        await c.rollback();
        return bad(res, "Member already has this book", 409);
      }
      if (l.n >= MAX_LOANS) {
        await c.rollback();
        return bad(res, `Loan limit of ${MAX_LOANS} books reached`, 409);
      }
      await c.query(
        "INSERT INTO issues(user_id,book_id,issued_at,due_date) VALUES(?,?,NOW(),DATE_ADD(NOW(),INTERVAL ? DAY))",
        [uid, b.id, days],
      );
      await c.query(
        "UPDATE books SET copies_available=copies_available-1 WHERE id=?",
        [b.id],
      );
      await c.commit();
      res.status(201).json({ ok: true });
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }),
);
app.post(
  "/api/issues/:id/return",
  auth(),
  wrap(async (req, res) => {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[i]] = await c.query(
        "SELECT * FROM issues WHERE id=? FOR UPDATE",
        [req.params.id],
      );
      if (!i || (req.user.role !== "admin" && i.user_id !== req.user.id)) {
        await c.rollback();
        return bad(res, "Loan not found", 404);
      }
      if (i.returned_at) {
        await c.rollback();
        return bad(res, "Already returned", 409);
      }
      const [[f]] = await c.query(
        `SELECT GREATEST(DATEDIFF(NOW(),due_date),0)*${FINE_PER_DAY} fine FROM issues WHERE id=?`,
        [i.id],
      );
      await c.query("UPDATE issues SET returned_at=NOW(), fine=? WHERE id=?", [
        f.fine,
        i.id,
      ]);
      await c.query(
        "UPDATE books SET copies_available=copies_available+1 WHERE id=?",
        [i.book_id],
      );
      await c.commit();
      res.json({ fine: f.fine });
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }),
);
app.get(
  "/api/stats",
  auth("admin"),
  wrap(async (req, res) => {
    const [[s]] =
      await pool.query(`SELECT (SELECT COUNT(*) FROM books) books,(SELECT COUNT(*) FROM users WHERE role='member') members,
    (SELECT COUNT(*) FROM issues WHERE returned_at IS NULL) active,(SELECT COUNT(*) FROM issues WHERE returned_at IS NULL AND due_date<NOW()) overdue`);
    res.json(s);
  }),
);

const port = process.env.PORT || 8080;
if (require.main === module)
  app.listen(port, () => console.log("LibraTrack on port " + port));
module.exports = app;
