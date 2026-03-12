const routes = [
  { id: 'login', label: 'Login', url: '/login' },
  { id: 'dashboard', label: 'Dashboard', url: '/dashboard', auth: true },
  { id: 'resources', label: 'Resources', url: '/resources' },
  { id: 'student_profile', label: 'Student Profile', url: '/student/profile', roles: ['Student'] },
  { id: 'student_courses', label: 'Student Courses', url: '/student/courses', roles: ['Student'] },
  { id: 'student_assignments', label: 'Student Assignments', url: '/student/assignments', roles: ['Student'] },
  { id: 'student_grades', label: 'Student Grades', url: '/student/grades', roles: ['Student'] },
  { id: 'student_transcript', label: 'Student Transcript', url: '/student/transcript', roles: ['Student'] },
  { id: 'admin_users', label: 'Manage Users', url: '/admin/users', roles: ['Admin'] },
  { id: 'admin_courses', label: 'Manage Courses', url: '/admin/courses', roles: ['Admin'] },
  { id: 'admin_enrollments', label: 'Manage Enrollments', url: '/admin/enrollments', roles: ['Admin', 'Registrar'] },
  { id: 'admin_students', label: 'Student Records', url: '/admin/students', roles: ['Admin', 'Registrar'] },
  { id: 'admin_grading', label: 'GPA Scale Editor', url: '/admin/grading-scale', roles: ['Admin'] },
  { id: 'finance_overview', label: 'Finance Overview', url: '/finance/overview', roles: ['Finance'] }
];

function findRoute(id) {
  return routes.find((route) => route.id === id) || null;
}

function roleCanAccess(route, role) {
  if (!route) return false;
  if (!route.roles) return true;
  if (!role) return false;
  return route.roles.includes(role);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildResponse({ message, links = [] }) {
  return { message, links };
}

function suggestLinksForRole(role) {
  const primary = routes.filter((route) => roleCanAccess(route, role));
  return primary.slice(0, 5).map((route) => ({ label: route.label, url: route.url }));
}

function getHelpResponse(text, role, loggedIn) {
  const input = normalize(text);

  if (!input) {
    return buildResponse({
      message: 'Hi! I can help you find pages, tasks, and resources. Try: "show my courses", "where is transcript", or "finance".'
    });
  }

  if (input.includes('help') || input.includes('what can you do')) {
    return buildResponse({
      message: 'I can guide you to key LMS pages like courses, assignments, transcripts, and finance records.',
      links: suggestLinksForRole(role)
    });
  }

  if (input.includes('resource') || input.includes('database') || input.includes('journal')) {
    return buildResponse({
      message: 'Open-access databases are listed on the Resources page.',
      links: [{ label: 'Resources', url: '/resources' }]
    });
  }

  if (input.includes('login') || input.includes('sign in')) {
    return buildResponse({
      message: 'Use the login page to access your dashboard.',
      links: [{ label: 'Login', url: '/login' }]
    });
  }

  if (input.includes('dashboard')) {
    return buildResponse({
      message: 'Your dashboard shows quick access to your modules.',
      links: loggedIn ? [{ label: 'Dashboard', url: '/dashboard' }] : [{ label: 'Login', url: '/login' }]
    });
  }

  if (input.includes('assignment')) {
    return buildResponse({
      message: 'Assignments live under your courses or student assignments view.',
      links: role === 'Student'
        ? [{ label: 'Student Assignments', url: '/student/assignments' }]
        : [{ label: 'Instructor Courses', url: '/instructor/courses' }]
    });
  }

  if (input.includes('grade') || input.includes('gpa')) {
    if (role === 'Admin') {
      return buildResponse({
        message: 'Admins can edit the GPA scale and view course grades.',
        links: [
          { label: 'GPA Scale Editor', url: '/admin/grading-scale' },
          { label: 'Student Records', url: '/admin/students' }
        ]
      });
    }
    if (role === 'Student') {
      return buildResponse({
        message: 'Your grades and transcript are here.',
        links: [
          { label: 'Grades', url: '/student/grades' },
          { label: 'Transcript', url: '/student/transcript' }
        ]
      });
    }
    return buildResponse({
      message: 'Grades are available to students and admins. Please sign in for access.',
      links: [{ label: 'Login', url: '/login' }]
    });
  }

  if (input.includes('transcript') || input.includes('certificate')) {
    if (role === 'Student') {
      return buildResponse({
        message: 'You can view your certificates and transcript here.',
        links: [
          { label: 'Certificates', url: '/student/certificates' },
          { label: 'Transcript', url: '/student/transcript' }
        ]
      });
    }
    if (role === 'Admin' || role === 'Registrar') {
      return buildResponse({
        message: 'Student transcripts are under Student Records.',
        links: [{ label: 'Student Records', url: '/admin/students' }]
      });
    }
  }

  if (input.includes('payment') || input.includes('finance') || input.includes('tuition')) {
    if (role === 'Finance') {
      return buildResponse({
        message: 'Use the finance overview to manage payments.',
        links: [{ label: 'Finance Overview', url: '/finance/overview' }]
      });
    }
    if (role === 'Student') {
      return buildResponse({
        message: 'Your payment history is available here.',
        links: [{ label: 'Payments', url: '/student/payments' }]
      });
    }
  }

  if (input.includes('attendance')) {
    if (role === 'Student') {
      return buildResponse({
        message: 'Your attendance records are here.',
        links: [{ label: 'Attendance', url: '/student/attendance' }]
      });
    }
    if (role === 'Instructor') {
      return buildResponse({
        message: 'You can record attendance in your courses list.',
        links: [{ label: 'Instructor Courses', url: '/instructor/courses' }]
      });
    }
  }

  if (input.includes('course')) {
    if (role === 'Student') {
      return buildResponse({
        message: 'Your enrolled courses are here.',
        links: [{ label: 'Student Courses', url: '/student/courses' }]
      });
    }
    if (role === 'Instructor') {
      return buildResponse({
        message: 'Your assigned courses are here.',
        links: [{ label: 'Instructor Courses', url: '/instructor/courses' }]
      });
    }
    if (role === 'Admin') {
      return buildResponse({
        message: 'Course management is available here.',
        links: [{ label: 'Manage Courses', url: '/admin/courses' }]
      });
    }
  }

  return buildResponse({
    message: 'I can help you navigate. Try asking about courses, assignments, grades, transcripts, finance, or resources.',
    links: suggestLinksForRole(role)
  });
}

module.exports = { getHelpResponse };
