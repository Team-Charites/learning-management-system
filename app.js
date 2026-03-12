require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const db = require('./db');
const { getHelpResponse } = require('./chatbot');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use((req, res, next) => {
  const userId = req.session.userId;
  if (!userId) {
    res.locals.currentUser = null;
    return next();
  }
  const user = db.prepare('SELECT id, full_name, email, role FROM users WHERE id = ?').get(userId);
  res.locals.currentUser = user || null;
  next();
});

function requireAuth(req, res, next) {
  if (!res.locals.currentUser) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!res.locals.currentUser) return res.redirect('/login');
    if (!roles.includes(res.locals.currentUser.role)) {
      return res.status(403).render('forbidden', { roles });
    }
    next();
  };
}

function ensureAdminUser() {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'Admin' LIMIT 1").get();
  if (admin) return;

  const defaultEmail = process.env.ADMIN_EMAIL || 'admin@collegeofchaplains.com';
  const defaultPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const passwordHash = bcrypt.hashSync(defaultPassword, 10);

  db.prepare(
    'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run('System Administrator', defaultEmail, passwordHash, 'Admin');

  console.log('--------------------------------------------------');
  console.log('Admin account created');
  console.log(`Email: ${defaultEmail}`);
  console.log(`Password: ${defaultPassword}`);
  console.log('Please change this password after first login.');
  console.log('--------------------------------------------------');
}

function generateReference(prefix, studentId) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${studentId}-${stamp}-${Math.floor(Math.random() * 900 + 100)}`;
}

function getGradingScale() {
  return db.prepare('SELECT letter, min_score, points FROM grading_scale ORDER BY min_score DESC').all();
}

function resolveGrade(score, scale) {
  if (score === null || score === undefined) return { letter: 'N/A', points: null };
  const found = scale.find((row) => score >= row.min_score);
  if (!found) return { letter: 'N/A', points: null };
  return { letter: found.letter, points: found.points };
}

function buildTranscript(studentId) {
  const courses = db.prepare(
    `SELECT courses.id, courses.title, courses.code, courses.level, courses.program, courses.credits
     FROM courses
     JOIN enrollments ON enrollments.course_id = courses.id
     WHERE enrollments.student_id = ?
     ORDER BY courses.title`
  ).all(studentId);

  const scale = getGradingScale();

  const rows = courses.map((course) => {
    const totals = db.prepare(
      `SELECT SUM(submissions.score) AS score_sum, SUM(assignments.max_score) AS max_sum
       FROM submissions
       JOIN assignments ON assignments.id = submissions.assignment_id
       WHERE submissions.student_id = ? AND assignments.course_id = ? AND submissions.score IS NOT NULL`
    ).get(studentId, course.id);

    const maxSum = totals?.max_sum || 0;
    const scoreSum = totals?.score_sum || 0;
    const average = maxSum > 0 ? (scoreSum / maxSum) * 100 : null;
    const grade = average === null ? { letter: 'N/A', points: null } : resolveGrade(average, scale);
    const letter = grade.letter;
    const gp = grade.points;

    return {
      ...course,
      average: average !== null ? Number(average.toFixed(2)) : null,
      letter,
      gp
    };
  });

  const totals = rows.reduce(
    (acc, row) => {
      if (row.gp !== null) {
        acc.totalCredits += row.credits;
        acc.totalPoints += row.gp * row.credits;
      }
      return acc;
    },
    { totalCredits: 0, totalPoints: 0 }
  );

  const gpa = totals.totalCredits > 0 ? Number((totals.totalPoints / totals.totalCredits).toFixed(2)) : null;

  return { rows, gpa, totalCredits: totals.totalCredits };
}

function getStudentProfile(studentId) {
  return db.prepare('SELECT * FROM student_profiles WHERE student_id = ?').get(studentId);
}

function drawPdfHeader(doc, subtitle) {
  doc.rect(30, 30, doc.page.width - 60, doc.page.height - 60).strokeColor('#1f8a70').lineWidth(1).stroke();
  doc.rect(40, 40, 515, 40).fill('#0f2e3d');
  doc.fillColor('white').fontSize(16).text('Chaplaincy College of Health Science and Technology', 50, 52);
  doc.circle(515, 60, 16).fill('#1f8a70');
  doc.fillColor('white').fontSize(10).text('CC', 507, 55);
  doc.fillColor('#0f2e3d').fontSize(11).text(subtitle, 50, 90);
  doc.moveDown(2);
}

function drawWatermark(doc, text) {
  const width = doc.page.width;
  const height = doc.page.height;
  doc.save();
  doc.fillColor('#0f2e3d');
  doc.opacity(0.08);
  doc.rotate(-25, { origin: [width / 2, height / 2] });
  doc.fontSize(60).text(text, width / 2 - 220, height / 2 - 40, { width: 440, align: 'center' });
  doc.opacity(1);
  doc.restore();
}

function drawSignature(doc, title) {
  doc.moveDown(2);
  doc.text('Signature: ___________________________', { align: 'left' });
  doc.text(title, { align: 'left' });
}

function renderTranscriptPdf(doc, student, profile, transcript) {
  drawPdfHeader(doc, 'Official Transcript');
  drawWatermark(doc, 'OFFICIAL');

  doc.fontSize(12).fillColor('#0b1f2a');
  doc.text(`Student: ${student.full_name}`);
  if (profile?.admission_no) doc.text(`Admission No: ${profile.admission_no}`);
  if (profile?.program) doc.text(`Program: ${profile.program}`);
  if (profile?.level) doc.text(`Level: ${profile.level}`);
  doc.moveDown(1);

  doc.fontSize(12).text('Course Results', { underline: true });
  doc.moveDown(0.5);

  transcript.rows.forEach((row) => {
    const avgLabel = row.average !== null ? `${row.average}%` : 'N/A';
    doc.text(`${row.code} - ${row.title} (${row.credits} credits) | Avg: ${avgLabel} | Grade: ${row.letter}`);
  });

  doc.moveDown(1);
  doc.text(`Total Credits: ${transcript.totalCredits}`);
  doc.text(`GPA: ${transcript.gpa !== null ? transcript.gpa : 'N/A'}`);

  drawSignature(doc, 'Registrar');
}

ensureAdminUser();
const freeResources = [
  { name: 'PubMed Central (PMC)', url: 'https://pmc.ncbi.nlm.nih.gov/' },
  { name: 'DOAJ (Directory of Open Access Journals)', url: 'https://doaj.org/' },
  { name: 'CDC', url: 'https://www.cdc.gov/' },
  { name: 'World Bank Open Data', url: 'https://data.worldbank.org/topic/open-data' },
  { name: 'National Academies Press (NAP)', url: 'https://nap.nationalacademies.org/' },
  { name: 'ReliefWeb', url: 'https://reliefweb.int/' },
  { name: 'PLOS Medicine', url: 'https://journals.plos.org/plosmedicine/' },
  { name: 'Global Health Action', url: 'https://www.tandfonline.com/journals/zgha20' },
  { name: 'BMJ Global Health', url: 'https://gh.bmj.com/' },
  { name: 'The Open Public Health Journal', url: 'https://openpublichealthjournal.com/' },
  { name: 'SpringerOpen', url: 'https://www.springeropen.com/' }
];
app.post('/chatbot', (req, res) => {
  const text = req.body.message || '';
  const role = res.locals.currentUser ? res.locals.currentUser.role : null;
  const loggedIn = Boolean(res.locals.currentUser);
  const reply = getHelpResponse(text, role, loggedIn);
  res.json(reply);
});
// Landing page
app.get('/', (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  res.render('landing');
});

app.get('/resources', (req, res) => {
  res.render('resources', { resources: freeResources });
});

// Auth
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db
    .prepare('SELECT id, full_name, email, role, password_hash FROM users WHERE email = ?')
    .get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: 'Invalid email or password.' });
  }

  req.session.userId = user.id;
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  res.render('dashboard');
});

// Admin routes
app.get('/admin/users', requireRole(['Admin']), (req, res) => {
  const users = db.prepare('SELECT id, full_name, email, role, created_at FROM users ORDER BY id DESC').all();
  res.render('admin/users', { users });
});

app.get('/admin/users/new', requireRole(['Admin']), (req, res) => {
  res.render('admin/user_new', { error: null });
});

app.post('/admin/users/new', requireRole(['Admin']), (req, res) => {
  const { full_name, email, role, password } = req.body;
  if (!full_name || !email || !role || !password) {
    return res.status(400).render('admin/user_new', { error: 'All fields are required.' });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    db.prepare(
      'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(full_name, email, passwordHash, role);
    res.redirect('/admin/users');
  } catch (err) {
    res.status(400).render('admin/user_new', { error: 'Email already exists.' });
  }
});

app.get('/admin/courses', requireRole(['Admin']), (req, res) => {
  const courses = db.prepare(
    `SELECT courses.*, users.full_name AS instructor_name
     FROM courses
     LEFT JOIN users ON users.id = courses.instructor_id
     ORDER BY courses.id DESC`
  ).all();
  res.render('admin/courses', { courses });
});

app.get('/admin/courses/new', requireRole(['Admin']), (req, res) => {
  const instructors = db.prepare("SELECT id, full_name FROM users WHERE role = 'Instructor'").all();
  res.render('admin/course_new', { instructors, error: null });
});

app.post('/admin/courses/new', requireRole(['Admin']), (req, res) => {
  const { title, code, description, program, level, credits, instructor_id } = req.body;
  if (!title || !code || !description || !program || !level) {
    const instructors = db.prepare("SELECT id, full_name FROM users WHERE role = 'Instructor'").all();
    return res.status(400).render('admin/course_new', { instructors, error: 'All fields except instructor are required.' });
  }
  try {
    db.prepare(
      'INSERT INTO courses (title, code, description, program, level, credits, instructor_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(title, code, description, program, level, credits || 3, instructor_id || null);
    res.redirect('/admin/courses');
  } catch (err) {
    const instructors = db.prepare("SELECT id, full_name FROM users WHERE role = 'Instructor'").all();
    res.status(400).render('admin/course_new', { instructors, error: 'Course code must be unique.' });
  }
});

app.get('/admin/courses/:id/assign', requireRole(['Admin', 'Registrar']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).render('not_found');
  const instructors = db.prepare("SELECT id, full_name FROM users WHERE role = 'Instructor'").all();
  res.render('admin/course_assign', { course, instructors, error: null });
});

app.post('/admin/courses/:id/assign', requireRole(['Admin', 'Registrar']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).render('not_found');
  const { instructor_id } = req.body;
  db.prepare('UPDATE courses SET instructor_id = ? WHERE id = ?').run(instructor_id || null, course.id);
  res.redirect('/admin/courses');
});

app.get('/admin/courses/assign/bulk', requireRole(['Admin', 'Registrar']), (req, res) => {
  const instructors = db.prepare("SELECT id, full_name FROM users WHERE role = 'Instructor'").all();
  const programs = db.prepare('SELECT DISTINCT program FROM courses WHERE program IS NOT NULL ORDER BY program').all().map(r => r.program);
  const levels = db.prepare('SELECT DISTINCT level FROM courses WHERE level IS NOT NULL ORDER BY level').all().map(r => r.level);

  const filters = {
    program: req.query.program || '',
    level: req.query.level || ''
  };

  let query = 'SELECT id, code, title, program, level FROM courses';
  const clauses = [];
  const params = [];
  if (filters.program) {
    clauses.push('program = ?');
    params.push(filters.program);
  }
  if (filters.level) {
    clauses.push('level = ?');
    params.push(filters.level);
  }
  if (clauses.length) query += ' WHERE ' + clauses.join(' AND ');
  query += ' ORDER BY title';

  const courses = db.prepare(query).all(...params);

  res.render('admin/course_bulk_assign', { instructors, courses, programs, levels, filters, error: null, saved: false });
});

app.post('/admin/courses/assign/bulk', requireRole(['Admin', 'Registrar']), (req, res) => {
  const instructorId = req.body.instructor_id;
  const courseIds = [].concat(req.body.course_ids || []);
  const action = req.body.action || 'assign';

  const programs = db.prepare('SELECT DISTINCT program FROM courses WHERE program IS NOT NULL ORDER BY program').all().map(r => r.program);
  const levels = db.prepare('SELECT DISTINCT level FROM courses WHERE level IS NOT NULL ORDER BY level').all().map(r => r.level);
  const filters = {
    program: req.body.program || '',
    level: req.body.level || ''
  };

  let query = 'SELECT id, code, title, program, level FROM courses';
  const clauses = [];
  const params = [];
  if (filters.program) {
    clauses.push('program = ?');
    params.push(filters.program);
  }
  if (filters.level) {
    clauses.push('level = ?');
    params.push(filters.level);
  }
  if (clauses.length) query += ' WHERE ' + clauses.join(' AND ');
  query += ' ORDER BY title';
  const courses = db.prepare(query).all(...params);

  const instructors = db.prepare("SELECT id, full_name FROM users WHERE role = 'Instructor'").all();

  if (courseIds.length === 0) {
    return res.status(400).render('admin/course_bulk_assign', { instructors, courses, programs, levels, filters, error: 'Select at least one course.', saved: false });
  }

  if (action === 'assign' && !instructorId) {
    return res.status(400).render('admin/course_bulk_assign', { instructors, courses, programs, levels, filters, error: 'Select an instructor for assignment.', saved: false });
  }

  const update = db.prepare('UPDATE courses SET instructor_id = ? WHERE id = ?');
  const tx = db.transaction(() => {
    courseIds.forEach((id) => update.run(action === 'assign' ? instructorId : null, id));
  });
  tx();

  res.render('admin/course_bulk_assign', { instructors, courses, programs, levels, filters, error: null, saved: true });
});

app.get('/admin/courses/export.csv', requireRole(['Admin', 'Registrar']), (req, res) => {
  const rows = db.prepare(
    `SELECT courses.code, courses.title, courses.program, courses.level, courses.credits,
            users.full_name AS instructor
     FROM courses
     LEFT JOIN users ON users.id = courses.instructor_id
     ORDER BY courses.title`
  ).all();

  const header = ['Code', 'Title', 'Program', 'Level', 'Credits', 'Instructor'];
  const csv = [header.join(',')]
    .concat(rows.map((row) => {
      const values = [row.code, row.title, row.program, row.level, row.credits, row.instructor || ''];
      return values.map((value) => `"${String(value || '').replace(/\"/g, '""')}"`).join(',');
    }))
    .join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=course-assignments.csv');
  res.send(csv);
});

app.get('/admin/grading-scale', requireRole(['Admin']), (req, res) => {
  const scale = getGradingScale();
  res.render('admin/grading_scale', { scale, error: null, saved: false });
});

app.post('/admin/grading-scale', requireRole(['Admin']), (req, res) => {
  const letters = [].concat(req.body.letter || []);
  const mins = [].concat(req.body.min_score || []);
  const points = [].concat(req.body.points || []);

  const rows = letters.map((letter, idx) => {
    const cleanLetter = String(letter || '').trim().toUpperCase();
    const minScore = Number(mins[idx]);
    const point = Number(points[idx]);
    if (!cleanLetter) return null;
    return { letter: cleanLetter, min_score: minScore, points: point };
  }).filter(Boolean);

  if (rows.length === 0) {
    return res.status(400).render('admin/grading_scale', { scale: getGradingScale(), error: 'Provide at least one grading row.', saved: false });
  }

  const letterSet = new Set();
  for (const row of rows) {
    if (Number.isNaN(row.min_score) || row.min_score < 0 || row.min_score > 100) {
      return res.status(400).render('admin/grading_scale', { scale: getGradingScale(), error: 'Min score must be between 0 and 100.', saved: false });
    }
    if (Number.isNaN(row.points) || row.points < 0 || row.points > 10) {
      return res.status(400).render('admin/grading_scale', { scale: getGradingScale(), error: 'Points must be between 0 and 10.', saved: false });
    }
    if (letterSet.has(row.letter)) {
      return res.status(400).render('admin/grading_scale', { scale: getGradingScale(), error: 'Letters must be unique.', saved: false });
    }
    letterSet.add(row.letter);
  }

  const ordered = rows.sort((a, b) => b.min_score - a.min_score);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM grading_scale').run();
    const insert = db.prepare('INSERT INTO grading_scale (letter, min_score, points) VALUES (?, ?, ?)');
    ordered.forEach((row) => insert.run(row.letter, row.min_score, row.points));
  });
  tx();

  res.render('admin/grading_scale', { scale: getGradingScale(), error: null, saved: true });
});

app.get('/admin/enrollments', requireRole(['Admin', 'Registrar']), (req, res) => {
  const enrollments = db.prepare(
    `SELECT enrollments.*, courses.title AS course_title, users.full_name AS student_name
     FROM enrollments
     JOIN courses ON courses.id = enrollments.course_id
     JOIN users ON users.id = enrollments.student_id
     ORDER BY enrollments.enrolled_at DESC`
  ).all();
  res.render('admin/enrollments', { enrollments });
});

app.get('/admin/enrollments/new', requireRole(['Admin', 'Registrar']), (req, res) => {
  const courses = db.prepare('SELECT id, title FROM courses ORDER BY title').all();
  const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
  res.render('admin/enrollment_new', { courses, students, error: null });
});

app.post('/admin/enrollments/new', requireRole(['Admin', 'Registrar']), (req, res) => {
  const { course_id, student_id } = req.body;
  if (!course_id || !student_id) {
    const courses = db.prepare('SELECT id, title FROM courses ORDER BY title').all();
    const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
    return res.status(400).render('admin/enrollment_new', { courses, students, error: 'Course and student are required.' });
  }
  try {
    db.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?, ?)').run(course_id, student_id);
    res.redirect('/admin/enrollments');
  } catch (err) {
    const courses = db.prepare('SELECT id, title FROM courses ORDER BY title').all();
    const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
    res.status(400).render('admin/enrollment_new', { courses, students, error: 'Student is already enrolled in that course.' });
  }
});

app.get('/admin/placements', requireRole(['Admin', 'Registrar', 'Chaplaincy Supervisor']), (req, res) => {
  const placements = db.prepare(
    `SELECT placements.*, users.full_name AS student_name
     FROM placements
     JOIN users ON users.id = placements.student_id
     ORDER BY placements.created_at DESC`
  ).all();
  res.render('admin/placements', { placements });
});

app.get('/admin/placements/new', requireRole(['Admin', 'Registrar', 'Chaplaincy Supervisor']), (req, res) => {
  const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
  res.render('admin/placement_new', { students, error: null });
});

app.post('/admin/placements/new', requireRole(['Admin', 'Registrar', 'Chaplaincy Supervisor']), (req, res) => {
  const { student_id, site_name, supervisor, start_date, end_date, status, notes } = req.body;
  if (!student_id || !site_name || !start_date) {
    const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
    return res.status(400).render('admin/placement_new', { students, error: 'Student, site name, and start date are required.' });
  }
  db.prepare(
    'INSERT INTO placements (student_id, site_name, supervisor, start_date, end_date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(student_id, site_name, supervisor || null, start_date, end_date || null, status || 'active', notes || null);
  res.redirect('/admin/placements');
});

app.get('/admin/certificates', requireRole(['Admin', 'Registrar']), (req, res) => {
  const certificates = db.prepare(
    `SELECT certificates.*, users.full_name AS student_name
     FROM certificates
     JOIN users ON users.id = certificates.student_id
     ORDER BY certificates.issued_at DESC`
  ).all();
  res.render('admin/certificates', { certificates });
});

app.get('/admin/certificates/new', requireRole(['Admin', 'Registrar']), (req, res) => {
  const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
  res.render('admin/certificate_new', { students, error: null });
});

app.post('/admin/certificates/new', requireRole(['Admin', 'Registrar']), (req, res) => {
  const { student_id, program, level, title } = req.body;
  if (!student_id || !program || !level || !title) {
    const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
    return res.status(400).render('admin/certificate_new', { students, error: 'All fields are required.' });
  }
  const reference = generateReference('CERT', student_id);
  try {
    db.prepare(
      'INSERT INTO certificates (student_id, program, level, title, reference) VALUES (?, ?, ?, ?, ?)'
    ).run(student_id, program, level, title, reference);
    res.redirect('/admin/certificates');
  } catch (err) {
    const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
    res.status(400).render('admin/certificate_new', { students, error: 'Certificate reference already exists.' });
  }
});

app.get('/admin/students', requireRole(['Admin', 'Registrar']), (req, res) => {
  const students = db.prepare(
    `SELECT users.id, users.full_name, users.email, student_profiles.admission_no, student_profiles.program, student_profiles.level
     FROM users
     LEFT JOIN student_profiles ON student_profiles.student_id = users.id
     WHERE users.role = 'Student'
     ORDER BY users.full_name`
  ).all();
  res.render('admin/students', { students });
});

app.get('/admin/students/:id/transcript', requireRole(['Admin', 'Registrar']), (req, res) => {
  const student = db.prepare('SELECT id, full_name, email FROM users WHERE id = ? AND role = "Student"').get(req.params.id);
  if (!student) return res.status(404).render('not_found');
  const profile = getStudentProfile(student.id);
  const transcript = buildTranscript(student.id);
  res.render('admin/transcript', { student, profile, transcript });
});

app.get('/admin/students/:id/transcript/pdf', requireRole(['Admin', 'Registrar']), (req, res) => {
  const student = db.prepare('SELECT id, full_name, email FROM users WHERE id = ? AND role = "Student"').get(req.params.id);
  if (!student) return res.status(404).render('not_found');
  const profile = getStudentProfile(student.id);
  const transcript = buildTranscript(student.id);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=transcript-${student.id}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  renderTranscriptPdf(doc, student, profile, transcript);
  doc.end();
});
// Certificates PDF
app.get('/certificates/:id/pdf', requireAuth, (req, res) => {
  const certificate = db.prepare(
    `SELECT certificates.*, users.full_name AS student_name
     FROM certificates
     JOIN users ON users.id = certificates.student_id
     WHERE certificates.id = ?`
  ).get(req.params.id);

  if (!certificate) return res.status(404).render('not_found');

  const role = res.locals.currentUser.role;
  const isOwner = res.locals.currentUser.id === certificate.student_id;
  const allowed = ['Admin', 'Registrar'].includes(role) || (role === 'Student' && isOwner);

  if (!allowed) return res.status(403).render('forbidden', { roles: ['Admin', 'Registrar', 'Student (owner)'] });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=certificate-${certificate.reference}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  drawPdfHeader(doc, 'Certificate of Completion');
  drawWatermark(doc, 'CERTIFICATE');

  doc.fontSize(12).fillColor('#0b1f2a').text('This is to certify that', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(18).text(certificate.student_name, { align: 'center' });
  doc.moveDown(0.8);
  doc.fontSize(12).text(`has completed the ${certificate.title} program`, { align: 'center' });
  doc.text(`Program: ${certificate.program} | Level: ${certificate.level}`, { align: 'center' });
  doc.moveDown(1.2);
  doc.text(`Issued: ${certificate.issued_at}`, { align: 'center' });
  doc.text(`Reference: ${certificate.reference}`, { align: 'center' });

  drawSignature(doc, 'Registrar');
  doc.end();
});

// Instructor routes
app.get('/instructor/courses', requireRole(['Instructor']), (req, res) => {
  const courses = db.prepare('SELECT * FROM courses WHERE instructor_id = ? ORDER BY id DESC').all(res.locals.currentUser.id);
  res.render('instructor/courses', { courses });
});

app.get('/instructor/courses/:id/lessons', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  const lessons = db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY order_index').all(course.id);
  res.render('instructor/lessons', { course, lessons });
});

app.get('/instructor/courses/:id/lessons/new', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  res.render('instructor/lesson_new', { course, error: null });
});

app.post('/instructor/courses/:id/lessons/new', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  const { title, content, order_index } = req.body;
  if (!title || !content) {
    return res.status(400).render('instructor/lesson_new', { course, error: 'Title and content are required.' });
  }
  db.prepare('INSERT INTO lessons (course_id, title, content, order_index) VALUES (?, ?, ?, ?)')
    .run(course.id, title, content, order_index || 1);
  res.redirect(`/instructor/courses/${course.id}/lessons`);
});

app.get('/instructor/courses/:id/assignments', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  const assignments = db.prepare('SELECT * FROM assignments WHERE course_id = ? ORDER BY created_at DESC').all(course.id);
  res.render('instructor/assignments', { course, assignments });
});

app.get('/instructor/courses/:id/assignments/new', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  res.render('instructor/assignment_new', { course, error: null });
});

app.post('/instructor/courses/:id/assignments/new', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  const { title, description, due_date, max_score } = req.body;
  if (!title || !description) {
    return res.status(400).render('instructor/assignment_new', { course, error: 'Title and description are required.' });
  }
  db.prepare(
    'INSERT INTO assignments (course_id, title, description, due_date, max_score) VALUES (?, ?, ?, ?, ?)'
  ).run(course.id, title, description, due_date || null, max_score || 100);
  res.redirect(`/instructor/courses/${course.id}/assignments`);
});

app.get('/instructor/assignments/:id/submissions', requireRole(['Instructor']), (req, res) => {
  const assignment = db.prepare(
    `SELECT assignments.*, courses.title AS course_title, courses.instructor_id
     FROM assignments
     JOIN courses ON courses.id = assignments.course_id
     WHERE assignments.id = ?`
  ).get(req.params.id);
  if (!assignment || assignment.instructor_id !== res.locals.currentUser.id) {
    return res.status(404).render('not_found');
  }
  const submissions = db.prepare(
    `SELECT submissions.*, users.full_name AS student_name
     FROM submissions
     JOIN users ON users.id = submissions.student_id
     WHERE submissions.assignment_id = ?
     ORDER BY submissions.submitted_at DESC`
  ).all(assignment.id);
  res.render('instructor/submissions', { assignment, submissions });
});

app.post('/instructor/submissions/:id/grade', requireRole(['Instructor']), (req, res) => {
  const submission = db.prepare(
    `SELECT submissions.*, assignments.course_id, courses.instructor_id
     FROM submissions
     JOIN assignments ON assignments.id = submissions.assignment_id
     JOIN courses ON courses.id = assignments.course_id
     WHERE submissions.id = ?`
  ).get(req.params.id);
  if (!submission || submission.instructor_id !== res.locals.currentUser.id) {
    return res.status(404).render('not_found');
  }
  const { score, feedback } = req.body;
  db.prepare(
    'UPDATE submissions SET score = ?, feedback = ?, graded_by = ?, graded_at = datetime(\'now\') WHERE id = ?'
  ).run(score || null, feedback || null, res.locals.currentUser.id, submission.id);
  res.redirect(`/instructor/assignments/${submission.assignment_id}/submissions`);
});

app.get('/instructor/courses/:id/attendance', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  const sessions = db.prepare('SELECT * FROM attendance_sessions WHERE course_id = ? ORDER BY session_date DESC').all(course.id);
  res.render('instructor/attendance', { course, sessions });
});

app.get('/instructor/courses/:id/attendance/new', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  res.render('instructor/attendance_new', { course, error: null });
});

app.post('/instructor/courses/:id/attendance/new', requireRole(['Instructor']), (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, res.locals.currentUser.id);
  if (!course) return res.status(404).render('not_found');
  const { session_date, topic } = req.body;
  if (!session_date || !topic) {
    return res.status(400).render('instructor/attendance_new', { course, error: 'Session date and topic are required.' });
  }
  db.prepare('INSERT INTO attendance_sessions (course_id, session_date, topic) VALUES (?, ?, ?)')
    .run(course.id, session_date, topic);
  res.redirect(`/instructor/courses/${course.id}/attendance`);
});

app.get('/instructor/attendance/:id/record', requireRole(['Instructor']), (req, res) => {
  const session = db.prepare(
    `SELECT attendance_sessions.*, courses.title AS course_title, courses.instructor_id
     FROM attendance_sessions
     JOIN courses ON courses.id = attendance_sessions.course_id
     WHERE attendance_sessions.id = ?`
  ).get(req.params.id);
  if (!session || session.instructor_id !== res.locals.currentUser.id) {
    return res.status(404).render('not_found');
  }
  const students = db.prepare(
    `SELECT users.id, users.full_name, enrollments.status
     FROM enrollments
     JOIN users ON users.id = enrollments.student_id
     WHERE enrollments.course_id = ?
     ORDER BY users.full_name`
  ).all(session.course_id);
  const existing = db.prepare('SELECT * FROM attendance_records WHERE session_id = ?').all(session.id);
  const statusMap = new Map(existing.map((row) => [row.student_id, row]));
  res.render('instructor/attendance_record', { session, students, statusMap });
});

app.post('/instructor/attendance/:id/record', requireRole(['Instructor']), (req, res) => {
  const session = db.prepare(
    `SELECT attendance_sessions.*, courses.instructor_id
     FROM attendance_sessions
     JOIN courses ON courses.id = attendance_sessions.course_id
     WHERE attendance_sessions.id = ?`
  ).get(req.params.id);
  if (!session || session.instructor_id !== res.locals.currentUser.id) {
    return res.status(404).render('not_found');
  }
  const students = db.prepare(
    `SELECT users.id
     FROM enrollments
     JOIN users ON users.id = enrollments.student_id
     WHERE enrollments.course_id = ?`
  ).all(session.course_id);

  const insert = db.prepare(
    'INSERT INTO attendance_records (session_id, student_id, status, notes) VALUES (?, ?, ?, ?)'
  );
  const update = db.prepare(
    'UPDATE attendance_records SET status = ?, notes = ?, recorded_at = datetime(\'now\') WHERE session_id = ? AND student_id = ?'
  );

  const tx = db.transaction(() => {
    students.forEach((student) => {
      const status = req.body[`status_${student.id}`] || 'present';
      const notes = req.body[`notes_${student.id}`] || null;
      const existing = db
        .prepare('SELECT id FROM attendance_records WHERE session_id = ? AND student_id = ?')
        .get(session.id, student.id);
      if (existing) {
        update.run(status, notes, session.id, student.id);
      } else {
        insert.run(session.id, student.id, status, notes);
      }
    });
  });

  tx();
  res.redirect(`/instructor/courses/${session.course_id}/attendance`);
});
// Student routes
app.get('/student/courses', requireRole(['Student']), (req, res) => {
  const courses = db.prepare(
    `SELECT courses.*
     FROM enrollments
     JOIN courses ON courses.id = enrollments.course_id
     WHERE enrollments.student_id = ?
     ORDER BY courses.title`
  ).all(res.locals.currentUser.id);
  res.render('student/courses', { courses });
});

app.get('/student/courses/:id', requireRole(['Student']), (req, res) => {
  const enrollment = db.prepare('SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?')
    .get(req.params.id, res.locals.currentUser.id);
  if (!enrollment) return res.status(403).render('forbidden', { roles: ['Student (enrolled)'] });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  const lessons = db.prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY order_index').all(course.id);
  res.render('student/course', { course, lessons });
});

app.get('/student/assignments', requireRole(['Student']), (req, res) => {
  const assignments = db.prepare(
    `SELECT assignments.*, courses.title AS course_title
     FROM assignments
     JOIN courses ON courses.id = assignments.course_id
     JOIN enrollments ON enrollments.course_id = courses.id
     WHERE enrollments.student_id = ?
     ORDER BY assignments.due_date IS NULL, assignments.due_date DESC`
  ).all(res.locals.currentUser.id);
  res.render('student/assignments', { assignments });
});

app.get('/student/assignments/:id', requireRole(['Student']), (req, res) => {
  const assignment = db.prepare(
    `SELECT assignments.*, courses.title AS course_title
     FROM assignments
     JOIN courses ON courses.id = assignments.course_id
     JOIN enrollments ON enrollments.course_id = courses.id
     WHERE assignments.id = ? AND enrollments.student_id = ?`
  ).get(req.params.id, res.locals.currentUser.id);
  if (!assignment) return res.status(404).render('not_found');
  const submission = db.prepare(
    'SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?'
  ).get(assignment.id, res.locals.currentUser.id);
  res.render('student/assignment_detail', { assignment, submission, error: null });
});

app.post('/student/assignments/:id/submit', requireRole(['Student']), (req, res) => {
  const assignment = db.prepare(
    `SELECT assignments.*, courses.id AS course_id
     FROM assignments
     JOIN courses ON courses.id = assignments.course_id
     JOIN enrollments ON enrollments.course_id = courses.id
     WHERE assignments.id = ? AND enrollments.student_id = ?`
  ).get(req.params.id, res.locals.currentUser.id);
  if (!assignment) return res.status(404).render('not_found');
  const { content } = req.body;
  if (!content) {
    const submission = db.prepare(
      'SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?'
    ).get(assignment.id, res.locals.currentUser.id);
    return res.status(400).render('student/assignment_detail', { assignment, submission, error: 'Submission content is required.' });
  }
  const existing = db.prepare(
    'SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ?'
  ).get(assignment.id, res.locals.currentUser.id);
  if (existing) {
    db.prepare('UPDATE submissions SET content = ?, submitted_at = datetime(\'now\') WHERE id = ?')
      .run(content, existing.id);
  } else {
    db.prepare('INSERT INTO submissions (assignment_id, student_id, content) VALUES (?, ?, ?)')
      .run(assignment.id, res.locals.currentUser.id, content);
  }
  res.redirect(`/student/assignments/${assignment.id}`);
});

app.get('/student/grades', requireRole(['Student']), (req, res) => {
  const grades = db.prepare(
    `SELECT submissions.score, submissions.graded_at, submissions.feedback,
            assignments.title AS assignment_title, assignments.max_score,
            courses.title AS course_title
     FROM submissions
     JOIN assignments ON assignments.id = submissions.assignment_id
     JOIN courses ON courses.id = assignments.course_id
     WHERE submissions.student_id = ? AND submissions.score IS NOT NULL
     ORDER BY submissions.graded_at DESC`
  ).all(res.locals.currentUser.id);
  res.render('student/grades', { grades });
});

app.get('/student/attendance', requireRole(['Student']), (req, res) => {
  const attendance = db.prepare(
    `SELECT attendance_sessions.session_date, attendance_sessions.topic, courses.title AS course_title,
            attendance_records.status, attendance_records.notes
     FROM attendance_records
     JOIN attendance_sessions ON attendance_sessions.id = attendance_records.session_id
     JOIN courses ON courses.id = attendance_sessions.course_id
     WHERE attendance_records.student_id = ?
     ORDER BY attendance_sessions.session_date DESC`
  ).all(res.locals.currentUser.id);
  res.render('student/attendance', { attendance });
});

app.get('/student/placement', requireRole(['Student']), (req, res) => {
  const placements = db.prepare(
    `SELECT * FROM placements WHERE student_id = ? ORDER BY created_at DESC`
  ).all(res.locals.currentUser.id);
  res.render('student/placement', { placements });
});

app.get('/student/payments', requireRole(['Student']), (req, res) => {
  const payments = db.prepare(
    `SELECT * FROM payments WHERE student_id = ? ORDER BY created_at DESC`
  ).all(res.locals.currentUser.id);
  res.render('student/payments', { payments });
});

app.get('/student/certificates', requireRole(['Student']), (req, res) => {
  const certificates = db.prepare(
    `SELECT * FROM certificates WHERE student_id = ? ORDER BY issued_at DESC`
  ).all(res.locals.currentUser.id);
  res.render('student/certificates', { certificates });
});

app.get('/student/profile', requireRole(['Student']), (req, res) => {
  const profile = getStudentProfile(res.locals.currentUser.id);
  res.render('student/profile', { profile, saved: false });
});

app.post('/student/profile', requireRole(['Student']), (req, res) => {
  const profile = getStudentProfile(res.locals.currentUser.id);
  const payload = {
    admission_no: req.body.admission_no || null,
    phone: req.body.phone || null,
    gender: req.body.gender || null,
    date_of_birth: req.body.date_of_birth || null,
    address: req.body.address || null,
    guardian_name: req.body.guardian_name || null,
    guardian_phone: req.body.guardian_phone || null,
    program: req.body.program || null,
    level: req.body.level || null
  };

  if (profile) {
    db.prepare(
      `UPDATE student_profiles SET admission_no = ?, phone = ?, gender = ?, date_of_birth = ?, address = ?,
        guardian_name = ?, guardian_phone = ?, program = ?, level = ?, updated_at = datetime('now')
       WHERE student_id = ?`
    ).run(
      payload.admission_no,
      payload.phone,
      payload.gender,
      payload.date_of_birth,
      payload.address,
      payload.guardian_name,
      payload.guardian_phone,
      payload.program,
      payload.level,
      res.locals.currentUser.id
    );
  } else {
    db.prepare(
      `INSERT INTO student_profiles (student_id, admission_no, phone, gender, date_of_birth, address, guardian_name, guardian_phone, program, level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      res.locals.currentUser.id,
      payload.admission_no,
      payload.phone,
      payload.gender,
      payload.date_of_birth,
      payload.address,
      payload.guardian_name,
      payload.guardian_phone,
      payload.program,
      payload.level
    );
  }

  const updated = getStudentProfile(res.locals.currentUser.id);
  res.render('student/profile', { profile: updated, saved: true });
});

app.get('/student/transcript', requireRole(['Student']), (req, res) => {
  const transcript = buildTranscript(res.locals.currentUser.id);
  const profile = getStudentProfile(res.locals.currentUser.id);
  res.render('student/transcript', { transcript, profile });
});

app.get('/student/transcript/pdf', requireRole(['Student']), (req, res) => {
  const transcript = buildTranscript(res.locals.currentUser.id);
  const profile = getStudentProfile(res.locals.currentUser.id);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename=transcript.pdf');

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  renderTranscriptPdf(doc, res.locals.currentUser, profile, transcript);
  doc.end();
});
// Finance
app.get('/finance/overview', requireRole(['Finance']), (req, res) => {
  const payments = db.prepare(
    `SELECT payments.*, users.full_name AS student_name
     FROM payments
     JOIN users ON users.id = payments.student_id
     ORDER BY payments.created_at DESC`
  ).all();
  res.render('finance/overview', { payments });
});

app.get('/finance/payments/new', requireRole(['Finance']), (req, res) => {
  const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
  res.render('finance/payment_new', { students, error: null });
});

app.post('/finance/payments/new', requireRole(['Finance']), (req, res) => {
  const { student_id, amount, currency, purpose, status, reference, paid_at } = req.body;
  if (!student_id || !amount || !purpose) {
    const students = db.prepare("SELECT id, full_name FROM users WHERE role = 'Student' ORDER BY full_name").all();
    return res.status(400).render('finance/payment_new', { students, error: 'Student, amount, and purpose are required.' });
  }
  const safeReference = reference || generateReference('PAY', student_id);
  db.prepare(
    'INSERT INTO payments (student_id, amount, currency, purpose, status, reference, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(student_id, amount, currency || 'NGN', purpose, status || 'pending', safeReference, paid_at || null);
  res.redirect('/finance/overview');
});

app.post('/finance/payments/:id/mark-paid', requireRole(['Finance']), (req, res) => {
  db.prepare('UPDATE payments SET status = ?, paid_at = datetime(\'now\') WHERE id = ?')
    .run('paid', req.params.id);
  res.redirect('/finance/overview');
});

// Chaplaincy Supervisor
app.get('/chaplaincy/overview', requireRole(['Chaplaincy Supervisor']), (req, res) => {
  const placements = db.prepare(
    `SELECT placements.*, users.full_name AS student_name
     FROM placements
     JOIN users ON users.id = placements.student_id
     ORDER BY placements.created_at DESC`
  ).all();
  res.render('chaplaincy/overview', { placements });
});

// Fallbacks
app.use((req, res) => {
  res.status(404).render('not_found');
});

app.listen(PORT, () => {
  console.log(`LMS running at http://localhost:${PORT}`);
});
























