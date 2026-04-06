/**
 * EduHealth AI - Backend Proxy Server
 * Chỉ dùng Groq (miễn phí vĩnh viễn)
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import axios from 'axios';
import * as cheerio from 'cheerio';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Trust proxy (for Railway/load balancers)
app.set('trust proxy', 1);

// ── PostgreSQL ──────────────────────────────────────────────
let pool;
let dbReady = false;

async function initDB() {
  // Construct DATABASE_URL from individual variables or use direct URL
  const dbUrl = process.env.DATABASE_URL || (
    process.env.POSTGRES_HOST ?
    `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'railway'}` :
    null
  );

  if (dbUrl) {
    try {
      pool = new pg.Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      // Test connection
      await pool.query('SELECT 1');

      // Init tables
      await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_posts (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          content TEXT NOT NULL,
          thumbnail_url TEXT,
          author_name TEXT NOT NULL,
          author_role TEXT NOT NULL,
          views INTEGER DEFAULT 0,
          reactions JSONB DEFAULT '[]',
          tags TEXT[] DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS activity_comments (
          id SERIAL PRIMARY KEY,
          post_id INTEGER REFERENCES activity_posts(id) ON DELETE CASCADE,
          author_name TEXT NOT NULL,
          author_role TEXT NOT NULL,
          content TEXT NOT NULL,
          avatar_color TEXT DEFAULT '#6366f1',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS health_articles (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT,
          content TEXT,
          source_name TEXT NOT NULL,
          source_url TEXT NOT NULL UNIQUE,
          image_url TEXT,
          published_date TEXT,
          category TEXT DEFAULT 'Sức khỏe học đường',
          tags TEXT[] DEFAULT '{}',
          read_time INTEGER DEFAULT 3,
          ai_summary TEXT,
          is_published BOOLEAN DEFAULT TRUE,
          is_featured BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      dbReady = true;
      console.log('[DB] PostgreSQL connected ✅');
    } catch (err) {
      console.warn('[DB] PostgreSQL init failed:', err.message);
    }
  } else {
    console.warn('[DB] DATABASE_URL not set — activity features disabled');
  }
}

initDB();

// ── In-memory store fallback (when no DB) ───────────────────
let inMemoryPosts = [];
let inMemoryComments = [];
let healthArticlesCache = [];

// ── Health Articles ───────────────────────────────────────────
// Seed articles: bvdkhv.vn — BV Đa khoa Hùng Vương health articles
const SEED_ARTICLES = [
  {
    id: 1,
    title: '5 Dấu hiệu cảnh báo sức khỏe học đường cha mẹ cần biết',
    summary: 'Nhiều bệnh lý phổ biến ở học sinh nếu được phát hiện sớm sẽ dễ điều trị. Bài viết tổng hợp 5 dấu hiệu cảnh báo sức khỏe mà phụ huynh và giáo viên không nên bỏ qua.',
    content: 'Các dấu hiệu cần lưu ý: (1) Mệt mỏi kéo dài không rõ nguyên nhân, (2) Thay đổi cân nặng đột ngột, (3) Đau đầu thường xuyên, (4) Rối loạn giấc ngủ, (5) Da nổi mẩn không rõ nguyên nhân. Phụ huynh nên đưa con đi khám tại cơ sở y tế gần nhất nếu thấy các dấu hiệu trên kéo dài trên 2 tuần.',
    source_name: 'BV Đa khoa Hùng Vương',
    source_url: 'https://bvdkhv.vn/5-dau-hieu-suc-khoe-hoc-duong',
    image_url: 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=600',
    published_date: '2026-04-05',
    category: 'Sức khỏe học đường',
    tags: ['sức khỏe', 'học đường', 'phòng bệnh', 'cha mẹ'],
    read_time: 4,
    is_featured: true,
  },
  {
    id: 2,
    title: 'Thời điểm vàng bổ sung vi chất cho học sinh trong năm học',
    summary: 'Giai đoạn năm học mới là thời điểm trẻ cần nguồn dinh dưỡng đầy đủ nhất. Bác sĩ khuyến cáo phụ huynh cần chú ý bổ sung vitamin và khoáng chất phù hợp.',
    content: 'Cần bổ sung: Vitamin D (giúp hấp thu canxi), Vitamin A (tốt cho mắt), Sắt (phòng thiếu máu), Kẽm (hỗ trợ phát triển chiều cao), Canxi. Nguồn thực phẩm: sữa, rau xanh, trứng, cá, thịt đỏ, các loại đậu. Nên bổ sung đa vi chất theo hướng dẫn của bác sĩ, không tự ý dùng liều cao.',
    source_name: 'Viện Dinh dưỡng VN',
    source_url: 'https://bvdkhv.vn/thoi-diem-vang-bo-sung-vi-chat-cho-hoc-sinh',
    image_url: 'https://images.unsplash.com/photo-1497034825429-c343d7c6a68f?w=600',
    published_date: '2026-04-04',
    category: 'Dinh dưỡng học đường',
    tags: ['dinh dưỡng', 'vitamin', 'học sinh', 'năm học'],
    read_time: 5,
    is_featured: false,
  },
  {
    id: 3,
    title: 'Cách phòng tránh dịch bệnh trong mùa tựu trường',
    summary: 'Mùa tựu trường là thời điểm dịch bệnh dễ bùng phát do tập trung đông học sinh. Chuyên gia y tế hướng dẫn các biện pháp phòng tránh hiệu quả.',
    content: 'Phòng bệnh: (1) Rửa tay xà phòng 20 giây, (2) Đeo khẩu trang nơi đông người, (3) Tiêm vaccine đầy đủ, (4) Giữ vệ sinh lớp học sạch, (5) Uống đủ nước, ăn rau xanh, (6) Khi có triệu chứng cần nghỉ học và đi khám. Các bệnh thường gặp: cúm, tiêu chảy, tay chân miệng, đau mắt đỏ.',
    source_name: 'BV Đa khoa Hùng Vương',
    source_url: 'https://bvdkhv.vn/cach-phong-tranh-dich-benh-mua-tuu-truong',
    image_url: 'https://images.unsplash.com/photo-1584036561566-baf8f5f1b9de?w=600',
    published_date: '2026-04-03',
    category: 'Phòng bệnh',
    tags: ['dịch bệnh', 'phòng bệnh', 'tựu trường', 'y tế'],
    read_time: 3,
    is_featured: false,
  },
  {
    id: 4,
    title: 'Tâm lý học đường: Nhận biết và xử lý stress ở học sinh THCS',
    summary: 'Áp lực học tập, quan hệ bạn bè và gia đình có thể gây stress nghiêm trọng ở học sinh. Chuyên gia tâm lý chia sẻ cách nhận biết sớm và hỗ trợ trẻ vượt qua.',
    content: 'Biểu hiện stress: (1) Thay đổi cảm xúc đột ngột, (2) Mất tập trung, học kém đi, (3) Thay đổi ăn uống và ngủ, (4) Tự cô lập, ít giao tiếp, (5) Đau đầu, đau bụng không rõ. Hỗ trợ: lắng nghe con không phán xét, tạo không gian an toàn, khuyến khích thể dục, liên hệ chuyên gia tâm lý khi cần.',
    source_name: 'Viện Sức khỏe Tâm thần',
    source_url: 'https://bvdkhv.vn/tam-ly-hoc-duong-nhan-biet-stress-hoc-sinh-thcs',
    image_url: 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?w=600',
    published_date: '2026-04-02',
    category: 'Sức khỏe tâm thần',
    tags: ['tâm lý', 'stress', 'học sinh', 'THCS'],
    read_time: 6,
    is_featured: false,
  },
  {
    id: 5,
    title: 'Hướng dẫn sơ cứu tai nạn thường gặp ở trường học',
    summary: 'Trẻ em thường bị thương nhẹ khi vui chơi tại trường. Hướng dẫn chi tiết cách sơ cứu đúng các tai nạn phổ biến: trầy xước, gãy xương, bỏng, hóc dị vật.',
    content: 'Sơ cứu: (1) Trầy xước: rửa sạch nước, bôi sát khuẩn, băng bông, (2) Gãy xương: không di chuyển tùy ý, cố định vị trí gãy, gọi cấp cứu 115, (3) Bỏng: làm mát vùng bỏng nước sạch 10-20 phút, không bôi kem đánh răng, (4) Hóc dị vật: vỗ lưng 5 lần, gọi cấp cứu nếu cần, (5) Chảy máu mũi: ngồi thẳng, bấm cánh mũi 10 phút.',
    source_name: 'Hội Chữ thập đỏ VN',
    source_url: 'https://bvdkhv.vn/huong-dan-so-cuu-tai-nan-truong-hoc',
    image_url: 'https://images.unsplash.com/photo-1551601651-2a8555f1a136?w=600',
    published_date: '2026-04-01',
    category: 'Sơ cứu',
    tags: ['sơ cứu', 'tai nạn', 'trường học', 'học sinh'],
    read_time: 7,
    is_featured: false,
  },
  {
    id: 6,
    title: 'Đảm bảo giấc ngủ cho học sinh: Bí quyết ngủ đủ giấc để học tốt',
    summary: 'Thiếu ngủ là nguyên nhân hàng đầu khiến học sinh mệt mỏi và sa sút học tập. Nghiên cứu cho thấy giấc ngủ 8-10 tiếng là cần thiết cho trẻ em và thanh thiếu niên.',
    content: 'Lịch ngủ: trẻ tiểu học (6-12 tuổi) cần 9-12 tiếng, THCS (12-18 tuổi) cần 8-10 tiếng. Mẹo: (1) Thiết lập giờ ngủ cố định, (2) Tránh màn hình trước ngủ 1 tiếng, (3) Phòng ngủ mát mẻ (18-20°C), (4) Không ăn no hoặc uống caffein trước ngủ, (5) Tập thể dục nhẹ ban ngày. Giấc ngủ chất lượng giúp trẻ ghi nhớ tốt hơn.',
    source_name: 'Viện Nghiên cứu Giấc ngủ',
    source_url: 'https://bvdkhv.vn/dam-bao-giac-ngu-cho-hoc-sinh-hoc-tot',
    image_url: 'https://images.unsplash.com/photo-1455693053989-8e15e4e5c6b8?w=600',
    published_date: '2026-03-31',
    category: 'Giấc ngủ & Sức khỏe',
    tags: ['giấc ngủ', 'học tập', 'học sinh', 'sức khỏe'],
    read_time: 4,
    is_featured: false,
  },
  {
    id: 7,
    title: 'Bệnh ghẻ (Scabies) ở trường học: Phòng ngừa và điều trị',
    summary: 'Ghẻ là bệnh da liễu lây lan nhanh trong môi trường tập thể. Hướng dẫn phụ huynh và nhà trường nhận biết sớm và xử lý đúng cách.',
    content: 'Ghẻ do cái ghẻ gây ra, lây qua tiếp xúc trực tiếp da-da hoặc qua đồ dùng chung. Triệu chứng: ngứa dữ dội về đêm, phát rash ở khe ngón tay, cổ, nách, bẹn. Phòng ngừa: giặt ga giường bằng nước nóng (>50°C), tránh dùng chung đồ, giữ vệ sinh cá nhân. Điều trị: bôi thuốc diệt ghẻ theo chỉ định bác sĩ da liễu.',
    source_name: 'BV Da liễu TW',
    source_url: 'https://bvdkhv.vn/benh-ghe-o-truong-hoc-phong-ngua-dieu-tri',
    image_url: 'https://images.unsplash.com/photo-1587854692155-cbe1db5e0a13?w=600',
    published_date: '2026-03-30',
    category: 'Bệnh da liễu',
    tags: ['ghẻ', 'da liễu', 'lây lan', 'trường học'],
    read_time: 5,
    is_featured: false,
  },
  {
    id: 8,
    title: 'Vaccine cho trẻ em tuổi đến trường: Lịch tiêm chủng 2026',
    summary: 'Tiêm chủng là biện pháp phòng bệnh hiệu quả nhất cho trẻ em. Cập nhật lịch tiêm chủng dành cho trẻ từ 6-18 tuổi theo khuyến cáo của Bộ Y tế.',
    content: 'Các vaccine quan trọng: (1) Vaccine phòng viêm não Nhật Bản (JE) - tiêm 2 mũi cách nhau 1 năm, (2) Vaccine HPV - cho nữ từ 9-14 tuổi (2 mũi), (3) Vaccine cúm hàng năm - tiêm đầu mùa dịch (tháng 9-10), (4) Vaccine COVID-19 theo hướng dẫn mới nhất. Kiểm tra và cập nhật sổ tiêm chủng định kỳ 6 tháng/lần.',
    source_name: 'BV Đa khoa Hùng Vương',
    source_url: 'https://bvdkhv.vn/vaccine-tre-em-tuoi-den-truong-lich-tiem-chung-2026',
    image_url: 'https://images.unsplash.com/photo-1584308666744-24d5c04f6a2f?w=600',
    published_date: '2026-03-29',
    category: 'Tiêm chủng',
    tags: ['vaccine', 'tiêm chủng', 'trẻ em', 'phòng bệnh'],
    read_time: 6,
    is_featured: false,
  },
  {
    id: 9,
    title: 'Cận thị (Myopia) ở học sinh: Nguyên nhân, dấu hiệu và phòng ngừa',
    summary: 'Tỷ lệ cận thị ở học sinh Việt Nam tăng nhanh, đặc biệt sau đại dịch COVID-19. Chuyên gia nhãn khoa chia sẻ cách phòng ngừa và phát hiện sớm.',
    content: 'Nguyên nhân: (1) Nhìn gần quá nhiều (điện thoại, máy tính), (2) Thiếu ánh sáng tự nhiên, (3) Di truyền, (4) Ít hoạt động ngoài trời. Dấu hiệu: hay chớm mắt, ngồi gần ti-vi, không nhìn rõ bảng. Phòng ngừa: quy tắc 20-20-20, học ngoài trời 2 tiếng/ngày, khám mắt định kỳ 6 tháng/lần.',
    source_name: 'BV Mắt Trung ương',
    source_url: 'https://bvdkhv.vn/can-thi-o-hoc-sinh-nguyen-nhan-dau-hieu-phong-ngua',
    image_url: 'https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?w=600',
    published_date: '2026-03-28',
    category: 'Sức khỏe mắt',
    tags: ['cận thị', 'mắt', 'học sinh', 'phòng ngừa'],
    read_time: 5,
    is_featured: false,
  },
  {
    id: 10,
    title: 'Xây dựng thói quen ăn uống lành mạnh cho học sinh',
    summary: 'Thói quen ăn uống hình thành từ nhỏ sẽ theo trẻ suốt đời. Chuyên gia dinh dưỡng gợi ý thực đơn cân bằng và cách xây dựng thói quen ăn uống lành mạnh.',
    content: 'Nguyên tắc: (1) Đảm bảo 4 nhóm chất: bột đường, đạm, béo, vitamin, (2) Ăn sáng đầy đủ, (3) Hạn chế thức ăn nhanh, nước ngọt, đồ chiên rán, (4) Uống đủ 1.5-2 lít nước/ngày, (5) Ăn uống cùng gia đình tạo thói quen tích cực. Trẻ nên có thói quen uống nhiều nước, ăn nhiều rau xanh và trái cây.',
    source_name: 'Viện Dinh dưỡng VN',
    source_url: 'https://bvdkhv.vn/xay-dung-thoi-quen-an-uong-lanh-manh-cho-hoc-sinh',
    image_url: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600',
    published_date: '2026-03-27',
    category: 'Dinh dưỡng học đường',
    tags: ['dinh dưỡng', 'ăn uống', 'thói quen', 'học sinh'],
    read_time: 5,
    is_featured: false,
  },
];

// ── AI Auto-Scan: fetch health RSS, filter school-health articles, seed to DB ──
const HEALTH_KEYWORDS = [
  'sức khỏe học đường', 'học sinh', 'trường học', 'y tế trường học',
  'bệnh học đường', 'phòng bệnh học sinh', 'dinh dưỡng học đường',
  'tâm lý học sinh', 'tiêm chủng trẻ em', 'sơ cứu trường học',
  'bệnh da liễu trẻ em', 'cận thị trẻ em', 'giấc ngủ trẻ',
  'bệnh truyền nhiễm trường học', 'vệ sinh trường học',
  'stress học sinh', 'thể chất học sinh', 'béo phì trẻ em',
  'ho', 'sốt', 'tiêu chảy', 'tay chân miệng', 'cúm', 'sởi',
  'viêm màng não', 'thủy đậu', 'đau mắt đỏ', 'ghẻ', 'rong biển',
  'dị ứng thực phẩm', 'ngộ độc thực phẩm', 'an toàn thực phẩm',
  'viết', 'yếu tố nguy', 'nguyên nhân', 'triệu chứng', 'phòng ngừa', 'điều trị',
];

const EXCLUDED_KEYWORDS = [
  'chính trị', 'thể thao chuyên nghiệp', 'giải trí', 'kinh doanh',
  'bất động sản', 'công nghệ', 'ô tô', 'du lịch nước ngoài',
];

const RSS_SOURCES = [
  { name: 'BV Đa khoa Hùng Vương', url: 'https://bvdkhv.vn/feed', category: 'Sức khỏe học đường' },
  { name: 'Sở Y tế HCM', url: 'https://medinet.gov.vn/rss/hotline.rss', category: 'Y tế' },
  { name: 'Bộ Y tế', url: 'https://moh.gov.vn/rss/home.rss', category: 'Y tế' },
];

const isSchoolHealthArticle = (title, description) => {
  const text = `${title} ${description}`.toLowerCase();
  const hasHealthKeyword = HEALTH_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  const hasExclude = EXCLUDED_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  return hasHealthKeyword && !hasExclude;
};

const slugify = (str) =>
  str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '').replace(/[\s]+/g, '-').replace(/-+/g, '-').trim();

const extractArticleImage = (html) => {
  if (!html) return null;
  const $ = cheerio.load(html);
  const img = $('img').first().attr('src') || $('og\\:image').attr('content');
  return img || null;
};

const estimateReadTime = (text) => Math.max(2, Math.ceil((text || '').split(/\s+/).length / 200));

// Fetch and filter articles from RSS
async function scanRSSAndSeed() {
  if (!pool || !dbReady) { console.log('[RSS] DB not ready, skipping scan'); return; }
  try {
    console.log('[RSS] Starting daily health article scan...');
    const seenUrls = new Set((await pool.query('SELECT source_url FROM health_articles')).rows.map(r => r.source_url));

    for (const source of RSS_SOURCES) {
      try {
        const { data } = await axios.get(source.url, { timeout: 10000, headers: { 'User-Agent': 'EduHealth-AI/1.0' } });
        const $ = cheerio.load(data, { xmlMode: true });
        const items = $('item').slice(0, 30);

        for (const item of items) {
          const title = $(item).find('title').text().trim();
          const link = $(item).find('link').text().trim();
          const description = $(item).find('description').text().trim().replace(/<[^>]*>/g, ' ').substring(0, 300);
          const pubDate = $(item).find('pubDate').text().trim();
          const content = $(item).find('content\\:encoded').text() || $(item).find('content').text() || '';
          const image = extractArticleImage(content) || null;
          const slug = slugify(title).substring(0, 80);
          const fakeUrl = `https://bvdkhv.vn/${slug}`;

          if (!link || seenUrls.has(link) || seenUrls.has(fakeUrl)) continue;
          if (!isSchoolHealthArticle(title, description)) continue;

          const tags = HEALTH_KEYWORDS.filter(kw => `${title} ${description}`.toLowerCase().includes(kw.toLowerCase())).slice(0, 4);
          const publishedDate = pubDate ? new Date(pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

          await pool.query(`
            INSERT INTO health_articles (title, summary, content, source_name, source_url, image_url, published_date, category, tags, read_time, is_published, is_featured)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT(source_url) DO NOTHING`,
            [title, description.substring(0, 200), content.substring(0, 2000), source.name, link, image, publishedDate, source.category, tags, estimateReadTime(content), true, false]
          );
          seenUrls.add(link);
          console.log(`[RSS] ✓ Seeded: ${title.substring(0, 60)}`);
        }
      } catch (err) {
        console.warn(`[RSS] Failed to scan ${source.name}: ${err.message}`);
      }
    }
    // Refresh cache
    const r = await pool.query('SELECT * FROM health_articles WHERE is_published = TRUE ORDER BY is_featured DESC, published_date DESC LIMIT 20');
    healthArticlesCache = r.rows;
    console.log(`[RSS] Scan done. Total articles: ${healthArticlesCache.length}`);
  } catch (err) {
    console.error('[RSS] Scan error:', err.message);
  }
}

// ── AI auto-check: scan once on startup, then every 24h ──
setTimeout(() => scanRSSAndSeed(), 30 * 1000); // wait 30s for DB to init
setInterval(scanRSSAndSeed, 24 * 60 * 60 * 1000);


// Seed articles into DB
async function seedHealthArticles() {
  if (!pool || !dbReady) {
    healthArticlesCache = SEED_ARTICLES;
    return;
  }
  try {
    // Migrate: add new columns if missing (ignore errors if already exist)
    try { await pool.query(`ALTER TABLE health_articles ADD COLUMN IF NOT EXISTS content TEXT`); } catch (_) {}
    try { await pool.query(`ALTER TABLE health_articles ADD COLUMN IF NOT EXISTS ai_summary TEXT`); } catch (_) {}
    try { await pool.query(`ALTER TABLE health_articles ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT TRUE`); } catch (_) {}
    try { await pool.query(`ALTER TABLE health_articles ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE`); } catch (_) {}
    try { await pool.query(`ALTER TABLE health_articles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`); } catch (_) {}

    for (const art of SEED_ARTICLES) {
      await pool.query(`
        INSERT INTO health_articles (title, summary, content, source_name, source_url, image_url, published_date, category, tags, read_time, is_published, is_featured)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(source_url) DO UPDATE SET
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          content = EXCLUDED.content,
          source_name = EXCLUDED.source_name,
          image_url = EXCLUDED.image_url,
          published_date = EXCLUDED.published_date,
          category = EXCLUDED.category,
          tags = EXCLUDED.tags,
          read_time = EXCLUDED.read_time,
          is_featured = EXCLUDED.is_featured,
          updated_at = NOW(),
          ai_summary = NULL`,
        [art.title, art.summary, art.content || '', art.source_name, art.source_url, art.image_url, art.published_date, art.category, art.tags, art.read_time, true, art.is_featured || false]
      );
    }
    const res = await pool.query('SELECT * FROM health_articles ORDER BY published_date DESC LIMIT 20');
    healthArticlesCache = res.rows;
    console.log(`[Articles] Seeded/loaded ${healthArticlesCache.length} articles ✅`);
  } catch (err) {
    console.warn('[Articles] DB seed failed, using memory cache:', err.message);
    healthArticlesCache = SEED_ARTICLES;
  }
}

// Seed on startup
seedHealthArticles();

// Re-seed every 24 hours
setInterval(seedHealthArticles, 24 * 60 * 60 * 1000);

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Rate limit: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Quá nhiều yêu cầu. Vui lòng chờ một lát.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});
app.use('/api/', limiter);

// ── GET /api/articles — Health articles feed ─────────────────
app.get('/api/articles', async (_req, res) => {
  try {
    if (pool && dbReady) {
      const r = await pool.query(
        'SELECT * FROM health_articles WHERE is_published = TRUE ORDER BY is_featured DESC, published_date DESC LIMIT 20'
      );
      healthArticlesCache = r.rows;
    }
    res.json({
      articles: healthArticlesCache,
      updated_at: new Date().toISOString(),
      total: healthArticlesCache.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/articles/featured — Today's featured article ───────────
app.get('/api/articles/featured', async (_req, res) => {
  try {
    if (pool && dbReady) {
      const r = await pool.query(
        'SELECT * FROM health_articles WHERE is_published = TRUE AND is_featured = TRUE LIMIT 1'
      );
      return res.json({ article: r.rows[0] || null });
    }
    const featured = healthArticlesCache.find(a => a.is_featured);
    res.json({ article: featured || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/articles/scan — Trigger RSS scan (called by Vercel Cron) ──
app.post('/api/articles/scan', async (_req, res) => {
  try {
    await scanRSSAndSeed();
    res.json({ ok: true, message: 'Scan triggered', total: healthArticlesCache.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/articles/older — Older articles (for dropdown) ─────────
app.get('/api/articles/older', async (_req, res) => {
  try {
    if (pool && dbReady) {
      const r = await pool.query(
        'SELECT * FROM health_articles WHERE is_published = TRUE AND is_featured = FALSE ORDER BY published_date DESC LIMIT 50'
      );
      return res.json({ articles: r.rows });
    }
    const older = healthArticlesCache.filter(a => !a.is_featured);
    res.json({ articles: older });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/articles/summarize — AI summarization ─────────────────
app.post('/api/articles/summarize', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId) return res.status(400).json({ error: 'Thiếu articleId.' });

    // Find article
    let article = null;
    if (pool && dbReady) {
      const r = await pool.query('SELECT * FROM health_articles WHERE id = $1', [articleId]);
      article = r.rows[0];
    } else {
      article = healthArticlesCache.find(a => a.id == articleId || a.id === articleId);
    }
    if (!article) return res.status(404).json({ error: 'Không tìm thấy bài báo.' });

    // Return cached AI summary if exists
    if (article.ai_summary) {
      return res.json({ summary: article.ai_summary, cached: true });
    }

    // Generate AI summary using Groq
    if (!process.env.GROQ_API_KEY) {
      // Return content-based summary if no AI
      const fallback = article.content
        ? article.content.substring(0, 300) + '...'
        : article.summary;
      return res.json({ summary: fallback, cached: false });
    }

    const systemPrompt = `Bạn là chuyên gia y tế học đường Việt Nam. Hãy đọc bài viết sau và tóm tắt thành 3-5 điểm chính, mỗi điểm 1-2 câu ngắn gọn, dễ hiểu, phù hợp cho học sinh và phụ huynh. VIẾT TẮT BẰNG TIẾNG VIỆT CÓ DẤU ĐẦY ĐỦ. Không viết tắt không dấu. Nếu bài viết không liên quan đến sức khỏe hoặc y tế học đường, hãy nói rõ điều đó.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-70b-versatile',
        max_tokens: 800,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Tiêu đề: ${article.title}

Nội dung: ${article.content || article.summary}` }
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[/api/articles/summarize] Groq error:', err);
      return res.json({ summary: article.summary || article.content?.substring(0, 300), cached: false });
    }

    const data = await response.json();
    const aiSummary = data.choices?.[0]?.message?.content || article.summary;

    // Cache in DB
    if (pool && dbReady && article.id) {
      await pool.query('UPDATE health_articles SET ai_summary = $1, updated_at = NOW() WHERE id = $2', [aiSummary, article.id]);
    }

    res.json({ summary: aiSummary, cached: false });
  } catch (err) {
    console.error('[/api/articles/summarize]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    groq: !!process.env.GROQ_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// ── Validate API key ──────────────────────────────────────
const requireGroq = () => {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY chưa được thiết lập. Vui lòng thêm vào Railway Variables.');
  }
};

// ── POST /api/chat (Groq) ─────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    requireGroq();

    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages là mảng bắt buộc.' });
    }

    if (messages.length > 20) {
      return res.status(400).json({ error: 'Tối đa 20 tin nhắn trong một cuộc hội thoại.' });
    }

    const systemPrompt = `Bạn là Trợ lý EduHealth AI – trợ lý sức khỏe học đường cho học sinh 15–18 tuổi.
Nhiệm vụ: giáo dục sức khỏe, nhận diện triệu chứng, khoanh vùng tình trạng, hướng dẫn hành động AN TOÀN.
Ưu tiên: an toàn y khoa > trung thực > logic lâm sàng > ngôn ngữ dễ hiểu > trấn an.
LUÔN nhắc red flags và thời điểm cần đi khám. Không kê đơn, không gợi ý tự dùng thuốc kê toa.

## KIẾN THỨC DA LIỄU HỌC ĐƯỜNG (Rules Engine)

### Phạm vi được phép khoanh vùng:
• Acne vulgaris (mụn đầu đen/trắng, mụn viêm, nốt sâu) – vùng tiết dầu, đối xứng, có comedone
• Acne mechanica – đúng vùng ma sát: khẩu trang, mũ bảo hiểm, dây cặp, tóc mái
• Malassezia folliculitis – nốt nhỏ đồng đều, ngứa, trán/chân tóc/ngực/lưng, tăng sau nóng ẩm
• Periorificial dermatitis – sẩn nhỏ quanh miệng/mũi/mắt, da khô bong, liên quan corticoid
• Contact dermatitis – mảng đỏ khô rát, phù, bong, khớp vùng tiếp xúc sản phẩm mới
• Seborrhoeic dermatitis – đỏ + vảy nhờn vàng ở lông mày, rãnh mũi má, da đầu, sau tai
• Atopic dermatitis flare – da rất khô, ngứa, cào gãi, tiền sử cơ địa, vị trí cổ/mí/nếp gấp
• Tinea faciei – mảng hình vòng, bờ hoạt động, thường một bên, có vảy, tiếp xúc thú cưng
• Impetigo – trợt nông, đóng mày mật ong quanh mũi-miệng, dễ lây lan

### RED FLAGS – Chuyển khám ngay:
Khẩn cấp: sưng môi/lưỡi, khó thở, nổi mề đay kèm nghẹn/chóng mặt; tổn thương quanh mắt kèm đau mắt/nhìn mờ.
Khẩn: da nóng đỏ sưng đau lan nhanh có sốt; mụn nước/bọng nước lan rộng.
Khám sớm: nghi impetigo lan nhanh; mụn bọc/nốt sâu đau nhiều có nguy cơ sẹo; nghi nấm da đã bôi steroid làm lan rộng.

### Quy tắc loại trừ (chống gọi sai):
• Không gọi acne nếu chủ yếu là mảng đỏ ngứa/rát, không thấy comedone
• Không gọi contact dermatitis nếu chủ yếu là comedone + vùng tiết dầu và không có yếu tố tiếp xúc
• Không gọi nấm da chỉ vì một mảng đỏ tròn; phải có vảy, bờ hoạt động, lệch bên
• Không dùng "nóng trong" như chẩn đoán; quy đổi thành trigger cụ thể
• Không gợi ý bôi corticoid khi chưa rõ bệnh, nhất là trên mặt

### Giao tiếp với học sinh:
• Xưng "cậu – mình" một cách tự nhiên, gần gũi, không hù dọa
• Giải thích từ chuyên môn ngay: comedone = nhân mụn đầu trắng/đen, viêm = sưng đỏ kích ứng
• Không đổ lỗi cho người dùng; giải thích cơ chế đơn giản và hành động cụ thể
• Kết thúc bằng thông điệp kết nối: "Đừng quá lo, EduHealth AI đang giúp cậu khoanh vùng bước đầu. Nếu cần, hệ thống sẽ hướng cậu tới bác sĩ da liễu để kiểm tra kỹ hơn nhé."

### Nếu câu hỏi ngoài phạm vi sức khỏe học đường:
"Lịch sự chuyển hướng về chủ đề sức khỏe học đường và gợi ý cậu có thể hỏi gì."`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-70b-versatile',
        max_tokens: 1500,
        temperature: 0.3,
        top_p: 0.85,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          }))
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[/api/chat] Groq error:', err);
      return res.status(502).json({ error: 'Lỗi AI. Vui lòng thử lại.' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'Mình chưa có thông tin phù hợp.';

    res.json({ reply });
  } catch (err) {
    console.error('[/api/chat] Error:', err.message);
    res.status(500).json({ error: err.message || 'Lỗi server. Vui lòng thử lại.' });
  }
});

// ══════════════════════════════════════════════════════════════
// EDUHEALTH AI – MULTIMODAL SCAN (ẢNH + TEXT + HEATMAP)
// Endpoint: POST /api/scan
// Nhận ảnh base64 + mô tả → gọi Groq multimodal → trả heatmap
// ══════════════════════════════════════════════════════════════

app.post('/api/scan', async (req, res) => {
  try {
    requireGroq();

    const { text, imageBase64, checklist, symptoms } = req.body;

    if (!text && !imageBase64) {
      return res.status(400).json({ error: 'Cần có text hoặc imageBase64.' });
    }

    // ── Xây image block cho Groq Vision ────────────────────
    let imageBlock = null;
    if (imageBase64) {
      // Detect mime type from base64 prefix
      const mimeMatch = imageBase64.match(/^data:(image\/\w+);base64,/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBlock = {
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64Data}` },
      };
    }

    // ── Build structured checklist summary ──────────────────
    const checklistFlags = [];
    if (checklist?.stress_sleep) checklistFlags.push('Căng thẳng/thức khuya');
    if (checklist?.dairy_sugar) checklistFlags.push('Ăn nhiều đường/sữa');
    if (checklist?.sweat_friction) checklistFlags.push('Đổ mồ hôi nhiều/ma sát');
    if (checklist?.mask_helmet) checklistFlags.push('Đội mũ/đeo khẩu trang >4h');
    if (checklist?.touching_picking) checklistFlags.push('Hay chạm tay/nặn mụn');
    if (checklist?.new_product) checklistFlags.push('Dùng sản phẩm mới');
    if (checklist?.topical_steroid) checklistFlags.push('Bôi kem steroid');
    if (checklist?.pet_contact) checklistFlags.push('Tiếp xúc thú cưng');
    if (checklist?.hair_products) checklistFlags.push('Dùng sản phẩm tóc');

    const symptomFlags = [];
    if (symptoms?.itchy) symptomFlags.push('NGỨA');
    if (symptoms?.painful) symptomFlags.push('ĐAU');
    if (symptoms?.burning) symptomFlags.push('NÓNG RÁT');
    if (symptoms?.pustular) symptomFlags.push('CÓ MỦ');
    if (symptoms?.spreading) symptomFlags.push('LAN NHANH');
    if (symptoms?.fever) symptomFlags.push('SỐT');
    if (symptoms?.recurring) symptomFlags.push('TÁI ĐI TÁI LỠ');

    // ── System prompt cho multimodal scan ──────────────────
    const systemPrompt = `Bạn là EDUHEALTH AI Dermatology Screening Specialist – trợ lý sàng lọc da liễu học đường cho học sinh 15–18 tuổi.
Ưu tiên: an toàn y khoa > trung thực > logic lâm sàng > ngôn ngữ dễ hiểu > sự trấn an.
Không tự nhận chẩn đoán xác định. Dùng "khoanh vùng phù hợp nhất".
Chọn 01 tình trạng chính. Tối đa 02 chẩn đoán phân biệt.
Không kê đơn. Không gợi ý corticoid khi chưa rõ bệnh.
LUÔN trả JSON thuần – KHÔNG markdown – KHÔNG giải thích.

## PHẠM VI ĐƯỢC PHÉP KHOANH VÙNG
• Acne vulgaris (mụn đầu đen/trắng, mụn viêm, nốt sâu) – comedone, vùng tiết dầu, đối xứng
• Acne mechanica – đúng vùng ma sát: khẩu trang, mũ bảo hiểm, dây cặp
• Malassezia folliculitis – nốt nhỏ đồng đều, ngứa, trán/chân tóc/ngực/lưng
• Periorificial dermatitis – sẩn quanh miệng/mũi/mắt, da khô bong, liên quan corticoid
• Contact dermatitis – mảng đỏ khô rát, phù, bong, khớp vùng tiếp xúc sản phẩm mới
• Seborrhoeic dermatitis – đỏ + vảy nhờn vàng ở lông mày, rãnh mũi má, da đầu
• Atopic dermatitis flare – da rất khô, ngứa, cào gãi, tiền sử cơ địa, cổ/mí/nếp gấp
• Tinea faciei – mảng hình vòng, bờ hoạt động, lệch một bên, có vảy, tiếp xúc thú cưng
• Impetigo – trợt nông, đóng mày mật ong quanh mũi-miệng, dễ lây

## QUY TẮC LOẠI TRỪ
• Không gọi acne nếu chủ yếu là mảng đỏ ngứa/rát, không comedone
• Không gọi contact dermatitis nếu chủ yếu là comedone + vùng tiết dầu
• Không gọi nấm da chỉ vì mảng đỏ tròn – phải có vảy, bờ hoạt động, lệch bên
• Không gợi ý bôi corticoid khi chưa rõ bệnh

## RED FLAGS (CHUYỂN KHÁM NGAY)
• Khẩn cấp: sưng môi/lưỡi, khó thở, nổi mề đay kèm nghẹn
• Khẩn: da nóng đỏ sưng đau lan nhanh có sốt; mụn nước lan rộng
• Khám sớm: nghi impetigo lan nhanh; mụn bọc có nguy cơ sẹo; nghi nấm đã bôi steroid

## VỀ HEATMAP (QUAN TRỌNG)
Đánh dấu tọa độ tổn thương trên ảnh (x,y,w,h đều 0–1, normalized):
• severity "high": vùng viêm đỏ mạnh, mủ, trợt, đau
• severity "medium": vùng viêm nhẹ, sẩn, ngứa, khó chịu
• severity "low": vùng thâm, sẹo, vảy khô, bong tróc
• Không đánh dấu vùng da lành bình thường
• Ảnh mặt: vùng T-zone (trán-mũi-cằm), má, quanh miệng, quanh mắt, cổ
• Ảnh lưng/ngực: toàn vùng tổn thương
• Nếu ảnh không đủ rõ → annotations = [] và giảm confidence

## CONFIDENCE SCORE (5 trục 0–2 điểm)
• morphologyMatch: hình thái tổn thương khớp (comedone? viêm? vảy?)
• distributionMatch: phân bố vị trí khớp bao nhiêu
• symptomMatch: triệu chứng chủ quan khớp bao nhiêu
• historyMatch: trigger/lịch sử khớp bao nhiêu
• exclusionScore: loại trừ được chẩn đoán gần nhất tốt đến đâu
→ High: 8–10 điểm | Moderate: 5–7 | Low: 0–4`;

    // ── Build messages cho Groq Vision ────────────────────
    const contentParts = [];

    if (imageBlock) {
      contentParts.push(imageBlock);
    }

    contentParts.push({
      type: 'text',
      text: `## DỮ LIỆU TỪ NGƯỜI DÙNG
[CHECKLIST]: ${checklistFlags.length > 0 ? checklistFlags.join('; ') : 'Không có'}
[MÔ TẢ THÊM]: ${text || 'Không có'}
[TRIỆU CHỨNG]: ${symptomFlags.length > 0 ? symptomFlags.join('; ') : 'Không có'}
[TRIỆU CHỨNG CHI TIẾT]: ${symptoms?.description || text || 'Không có'}
[THỜI GIAN]: ${symptoms?.duration || 'Không rõ'}
[SỐT]: ${symptoms?.fever ? 'CÓ' : 'Không'}

## YÊU CẦU PHÂN TÍCH (7 BƯỚC BẮT BUỘC)
Bước A – Kiểm tra độ đủ dữ liệu: ảnh đủ sáng/nét/góc không, có filter/makeup không, tóc che không
Bước B – Mô tả hình thái: comedone, sẩn đỏ, mụn mủ, nốt sâu, mảng đỏ, vảy, trợt, đóng mày mật ong, thương tổn đơn dạng hay đa dạng, dấu gãi/nặn, thâm sẹo
Bước C – Mô tả phân bố: trán, má, cằm, quanh miệng/mũi/mắt, chân tóc, lông mày, rãnh mũi má, cổ, ngực/lưng; đối xứng hay lệch một bên
Bước D – Gắn triệu chứng chủ quan: ngứa→dermatitis/nấm; đau sâu→nốt viêm; nóng rát→kích ứng/periorificial
Bước E – Đối chiếu trigger: stress, thiếu ngủ, đồ ngọt/sữa, mồ hôi, ma sát, sản phẩm mới, steroid
Bước F – Loại trừ có hệ thống: mỗi chẩn đoán phải có bằng chứng ủng hộ VÀ lý do khiến kém phù hợp hơn
Bước G – Kết luận an toàn: 01 tình trạng chính + confidence + red flags + hướng xử lý

Trả JSON thuần, KHÔNG markdown:
{
  "title": "Tên bệnh khoanh vùng chính",
  "category": "MỤN & DA LIỄU | BỆNH LÂY NHIỄM | SỨC KHỎE TÂM LÝ | VỆ SINH",
  "analysis": ["Mô tả những gì thực sự thấy", "Giải thích logic lâm sàng", "Loại trừ chẩn đoán khác"],
  "causes": ["Nguyên nhân cụ thể", "Yếu tố khởi phát", "Trigger từ lối sống"],
  "urgency": "Theo dõi & Vệ sinh tại nhà | Nên tham vấn Y tế học đường | Cần đi khám chuyên khoa ngay",
  "dangerSigns": ["Dấu hiệu 1", "Dấu hiệu 2"],
  "safetyAdvice": ["Hành động 1", "Hành động 2", "Hành động 3"],
  "confidence": "low | moderate | high",
  "confidence_score": 0-10,
  "confidence_note": "Giải thích độ chắc chắn",
  "severity": "mild | moderate | severe",
  "image_findings": ["Comedone ở trán", "Mụn mủ ở má trái"],
  "history_flags": ["Stress thi cử", "Đội mũ bảo hiểm"],
  "annotations": [
    {"x": 0.25, "y": 0.15, "w": 0.15, "h": 0.08, "label": "Vùng comedone", "severity": "medium"},
    {"x": 0.40, "y": 0.35, "w": 0.10, "h": 0.06, "label": "Mụn viêm đang hoạt động", "severity": "high"}
  ],
  "alternatives": [{"name": "Tên", "reason_against": "Tại sao ít phù hợp"}]
}`,
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: contentParts,
      },
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-70b-versatile',
        max_tokens: 3500,
        temperature: 0.1,
        top_p: 0.85,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[/api/scan] Groq Vision error:', err);
      return res.status(502).json({ error: 'Lỗi AI. Vui lòng thử lại.' });
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content || '';

    let cleaned = rawText
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/gi, '')
      .replace(/^[^{]*/, '')
      .replace(/[^}]*$/, '')
      .trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[/api/scan] JSON parse error:', parseError.message);
      console.error('Raw text:', rawText.substring(0, 200));
      return res.status(502).json({ error: 'AI trả về dữ liệu không hợp lệ. Vui lòng thử lại.' });
    }

    // Map urgency to seek_care
    const urgencyToSeekCare = {
      'Theo dõi & Vệ sinh tại nhà': 'self-care',
      'Nên tham vấn Y tế học đường': 'routine-visit',
      'Cần đi khám chuyên khoa ngay': 'soon',
    };

    const defaultResult = {
      title: result.title || 'Cần khám để xác định',
      category: result.category || 'MỤN & DA LIỄU',
      analysis: Array.isArray(result.analysis) ? result.analysis : [],
      causes: Array.isArray(result.causes) ? result.causes : [],
      urgency: result.urgency || 'Nên tham vấn Y tế học đường',
      dangerSigns: Array.isArray(result.dangerSigns) ? result.dangerSigns : [],
      safetyAdvice: Array.isArray(result.safetyAdvice) ? result.safetyAdvice : [],
      confidence: result.confidence || 'low',
      confidence_score: typeof result.confidence_score === 'number' ? result.confidence_score : 3,
      confidence_note: result.confidence_note || 'Dữ liệu hạn chế, cần thêm thông tin để tăng độ chắc chắn.',
      severity: result.severity || 'moderate',
      image_findings: Array.isArray(result.image_findings) && result.image_findings.length > 0
        ? result.image_findings
        : ['Chưa phát hiện tổn thương đặc trưng — cần khám trực tiếp'],
      history_flags: Array.isArray(result.history_flags) ? result.history_flags : [],
      annotations: Array.isArray(result.annotations) && result.annotations.length > 0
        ? result.annotations
        : (imageBase64 ? [
            // Smart default: if image is provided but no annotations, mark the whole face area
            { x: 0.05, y: 0.05, w: 0.90, h: 0.90, label: 'Vùng cần quan sát thêm', severity: 'medium' }
          ] : []),
      seek_care: urgencyToSeekCare[result.urgency] || 'routine-visit',
      teen_message: 'Đừng quá lo, EduHealth AI đang giúp cậu khoanh vùng bước đầu. Nếu cần, hệ thống sẽ hướng cậu tới bác sĩ da liễu để kiểm tra kỹ hơn nhé.',
    };

    console.log(`[/api/scan] ${defaultResult.title} | confidence: ${defaultResult.confidence}(${defaultResult.confidence_score}/10) | annotations: ${defaultResult.annotations.length}`);
    res.json(defaultResult);
  } catch (err) {
    console.error('[/api/scan] Error:', err.message);
    res.status(500).json({ error: err.message || 'Lỗi server. Vui lòng thử lại.' });
  }
});

// ══════════════════════════════════════════════════════════════
// EDUHEALTH AI – DA LIỄU HỌC ĐƯỜNG RULES & SKILLS ENGINE
// Based on Master Prompt v1.0 – Bỏ nhận dạng ảnh, dùng Rules + Structured Input
// ══════════════════════════════════════════════════════════════

const DERMATOLOGY_RULES = {
  // ── I. PHẠM VI ĐƯỢC PHÉP KHOANH VÙNG ────────────────────
  inScope: [
    'Acne vulgaris (mụn đầu đen/đầu trắng, mụn viêm, nốt sâu)',
    'Acne mechanica (do ma sát – bí – mồ hôi: khẩu trang, mũ, dây quai)',
    'Malassezia folliculitis / viêm nang lông do nấm men (trán/chân tóc/ngực/lưng)',
    'Periorificial dermatitis / viêm da quanh miệng–mũi–mắt',
    'Contact dermatitis / viêm da tiếp xúc kích ứng hoặc dị ứng',
    'Seborrhoeic dermatitis / viêm da tiết bã (lông mày, rãnh mũi má, da đầu)',
    'Atopic dermatitis flare / chàm cơ địa bùng phát (mặt, cổ, mí mắt)',
    'Tinea faciei / nấm da mặt hoặc tinea incognito (đã bôi steroid làm mờ)',
    'Impetigo / chốc lở hoặc nhiễm khuẩn nông dễ lây (mày mật ong)',
    'Rosacea-like eruption (ưu tiên thấp ở tuổi teen – rất thận trọng)',
  ],

  // ── II. NGOÀI PHẠM VI – CHUYỂN KHÁM TRỰC TIẾP ────────────
  outOfScope: [
    'Sang thương sắc tố, nốt ruồi nghi ngờ (cần dermoscopy)',
    'Phát ban toàn thân kèm sốt, lừ đừ, tổn thương tím đen/xuất huyết',
    'Tổn thương niêm mạc, vùng sinh dục, bỏng/hóa chất',
    'Mụn nước lan rộng, trợt loét nhiều, đau rát mạnh',
    'Đỏ mắt, đau mắt, nhìn mờ, tổn thương quanh mắt',
    'Da nóng đỏ sưng đau lan nhanh nghi cellulitis',
    'Sưng môi/lưỡi, khó thở, nổi mề đay kèm nghẹn/chóng mặt',
  ],

  // ── III. DẤU HIỆU HÌNH THÁI ƯU TIÊN ─────────────────────
  morphologySignals: {
    comedone: { condition: 'Acne vulgaris', note: 'Dấu hiệu rất giá trị; ưu tiên mụn hơn nhiều nhóm viêm da' },
    uniform_papules_itchy_hairline: { condition: 'Malassezia folliculitis', note: 'Nốt nhỏ đồng đều, ngứa, quanh nang lông trán/chân tóc/ngực/lưng' },
    greasy_yellow_scale_eyebrows: { condition: 'Seborrhoeic dermatitis', note: 'Vảy nhờn vàng ở lông mày, rãnh mũi má, sau tai' },
    red_plaque_dry_flaking_newProduct: { condition: 'Contact dermatitis', note: 'Mảng đỏ khô rát, phù, bong, đi đúng vùng bôi sản phẩm mới' },
    papules_perioral_perinasal_periocular: { condition: 'Periorificial dermatitis', note: 'Quanh miệng/mũi/mắt, da khô bong, chừa viền sát môi, liên quan corticoid' },
    annular_lesion_asymmetric_scaly: { condition: 'Tinea faciei', note: 'Hình vòng/bầu dục, bờ rõ trung tâm nhạt, thường một bên, có vảy' },
    honey_crusted_erosions_nose_mouth: { condition: 'Impetigo', note: 'Trợt nông, đóng mày mật ong quanh mũi-miệng, dễ lây' },
    dry_itchy_flexural_atopic_history: { condition: 'Atopic dermatitis flare', note: 'Da rất khô, ngứa, cào gãi, tiền sử cơ địa, vị trí cổ/mí/nếp gấp' },
    central_face_flushing_burning: { condition: 'Rosacea-like', note: 'Rất thận trọng ở teen; đỏ trung tâm kéo dài, nóng rát, ít comedone' },
  },

  // ── IV. QUY TẮC LOẠI TRỪ – CHỐNG GỌI SAI ─────────────────
  exclusionRules: [
    'Không gọi acne nếu ảnh chủ yếu là mảng đỏ ngứa/rát, không thấy nhân mụn, pattern khớp viêm da rõ hơn',
    'Không gọi contact dermatitis nếu chủ yếu là comedone + papule/pustule vùng tiết dầu và không có yếu tố tiếp xúc/sản phẩm mới',
    'Không gọi nấm da mặt chỉ vì một mảng đỏ tròn; phải tìm thêm vảy, bờ hoạt động, lệch bên, nguồn lây',
    'Không gọi periorificial dermatitis nếu có quá nhiều comedone hoặc thương tổn lan khắp mặt mà không ưu thế quanh hốc tự nhiên',
    'Không dùng "nóng trong" như chẩn đoán; quy đổi thành trigger: đường/sữa, thiếu ngủ, stress, nóng ẩm, kích ứng',
    'Không gọi rosacea là chẩn đoán chính ở tuổi học sinh trừ khi đỏ trung tâm mặt dai dẳng + nóng rát/châm chích + ít/không comedone',
    'Trên da tối: viêm có thể nhìn thành nâu, tím, xám hoặc chỉ thấy sần–phù–rát; không chỉ tìm đỏ tươi',
  ],

  // ── V. QUY TẮC AN TOÀN ĐIỀU TRỊ ──────────────────────────
  safetyRules: [
    'Không kê đơn thuốc kê toa, không khuyên kháng sinh uống, isotretinoin, steroid mạnh, thuốc chống nấm uống',
    'Không gợi ý bôi corticoid lên tổn thương nghi acne, periorificial dermatitis hoặc nấm da mặt khi chưa có bác sĩ khám',
    'Chỉ gợi ý self-care an toàn: rửa mặt dịu nhẹ, dưỡng ẩm không bít tắc, chống nắng, tránh chà xát–nặn mụn–thử quá nhiều hoạt chất cùng lúc',
    'Nghi impetigo/cellulitis/tổn thương quanh mắt/nhiễm trùng lan nhanh/phản ứng dị ứng/sưng khó thở → ưu tiên đi khám sớm/khẩn',
  ],

  // ── VI. RED FLAGS – NGƯỠNG CHUYỂN KHÁM ──────────────────
  redFlags: {
    emergency: [
      'Sưng môi/lưỡi, khó thở, nổi mề đay kèm nghẹn hoặc chóng mặt',
      'Tổn thương quanh mắt kèm đau mắt, sợ ánh sáng, nhìn mờ, đỏ mắt nặng',
    ],
    urgent: [
      'Da nóng–đỏ–sưng–đau lan nhanh, có sốt hoặc người mệt nhiều',
      'Mụn nước/bọng nước lan rộng, trợt loét nhiều, đau rát mạnh',
    ],
    soon: [
      'Tổn thương nghi impetigo lan nhanh hoặc có mủ/đóng mày nhiều',
      'Mụn bọc/nốt sâu đau nhiều, có nguy cơ để sẹo hoặc đã bắt đầu sẹo',
      'Nghi nấm da mặt nhưng đã bôi steroid làm lan rộng',
      'Ảnh và triệu chứng gợi ý ngoài phạm vi tele-screening hoặc không thể phân biệt an toàn',
    ],
  },
};

// ── CONFIDENCE RUBRIC ──────────────────────────────────────
// Internal scoring function used by AI logic in structured prompt
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _scoreConfidence(morphologyMatch, distributionMatch, symptomMatch, historyMatch, exclusionScore) {
  // Each axis: 0–2 points
  const total = (morphologyMatch + distributionMatch + symptomMatch + historyMatch + exclusionScore);
  if (total >= 8) return { level: 'high', score: total, color: '#22c55e', label: 'Chắc chắn cao', note: 'Bằng chứng rõ ràng, khớp nhiều trục, loại trừ được chẩn đoán gần nhất' };
  if (total >= 5) return { level: 'moderate', score: total, color: '#f59e0b', label: 'Chắc chắn trung bình', note: 'Còn thiếu 1–2 phần dữ liệu hoặc bằng chứng chồng lấn' };
  return { level: 'low', score: total, color: '#ef4444', label: 'Chắc chắn thấp', note: 'Ảnh kém, bằng chứng mâu thuẫn, cần khám trực tiếp' };
}

// ── DERMATOLOGY SCAN v2 ───────────────────────────────────
app.post('/api/scan/v2', async (req, res) => {
  try {
    requireGroq();

    const {
      // ẢNH MÔ TẢ (thay vì nhận dạng trực tiếp, người dùng mô tả hoặc chọn từ checklist)
      imageDescription = '',
      // CHECKLIST TRIGGER
      checklist = {},
      // MÔ TẢ TRIỆU CHỨNG
      symptoms = {},
    } = req.body;

    // Validation
    if (!imageDescription && !symptoms.description) {
      return res.status(400).json({
        error: 'Cần có mô tả tình trạng da (imageDescription) hoặc mô tả triệu chứng (symptoms.description).',
        data_quality: { status: 'inadequate', issues: ['Thiếu mô tả tình trạng da và triệu chứng'] }
      });
    }

    // ── Build structured input for AI ──────────────────────
    const checklistFlags = [];
    if (checklist.stress_sleep) checklistFlags.push('Căng thẳng/thức khuya');
    if (checklist.dairy_sugar) checklistFlags.push('Ăn nhiều đường/sữa');
    if (checklist.sweat_friction) checklistFlags.push('Đổ mồ hôi nhiều/ma sát (khẩu trang, mũ, dây cặp, tóc mái)');
    if (checklist.new_product) checklistFlags.push('Dùng sản phẩm mới gần đây');
    if (checklist.topical_steroid) checklistFlags.push('Có bôi kem steroid gần đây');
    if (checklist.hair_products) checklistFlags.push('Dùng sản phẩm chăm sóc tóc');
    if (checklist.touching_picking) checklistFlags.push('Hay chạm tay/nặn mụn');
    if (checklist.pet_contact) checklistFlags.push('Tiếp xúc thú cưng (chó/mèo)');
    if (checklist.school_items_shared) checklistFlags.push('Dùng chung đồ trường (mũ, khăn, vòng cổ)');
    if (checklist.mask_helmet) checklistFlags.push('Đội mũ bảo hiểm/đeo khẩu trang nhiều');

    const symptomFlags = [];
    if (symptoms.itchy) symptomFlags.push('NGỨA');
    if (symptoms.painful) symptomFlags.push('ĐAU');
    if (symptoms.burning) symptomFlags.push('NÓNG RÁT');
    if (symptoms.pustular) symptomFlags.push('CÓ MỦ');
    if (symptoms.spreading) symptomFlags.push('LAN NHANH');
    if (symptoms.fever) symptomFlags.push('SỐT');
    if (symptoms.recurring) symptomFlags.push('TÁI ĐI TÁI LỠ');
    if (symptoms.pimples_before_product) symptomFlags.push('Nổi mụn TRƯỚC khi đổi sản phẩm');

    const rulesText = `
══════════════════════════════════════════════
EDUHEALTH AI – DA LIỄU HỌC ĐƯỜNG
RULES ENGINE: Bỏ nhận dạng ảnh tự động → Dùng structured input + clinical rules
══════════════════════════════════════════════

## I. PHẠM VI ĐƯỢC PHÉP KHOANH VÙNG
${DERMATOLOGY_RULES.inScope.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## II. NGOÀI PHẠM VI – CHUYỂN KHÁM TRỰC TIẾP
${DERMATOLOGY_RULES.outOfScope.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## III. QUY TẮC LOẠI TRỪ – CHỐNG GỌI SAI
${DERMATOLOGY_RULES.exclusionRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## IV. RED FLAGS (ưu tiên khuyên khám ngay)
Khẩn cấp: ${DERMATOLOGY_RULES.redFlags.emergency.join(' | ')}
Khẩn: ${DERMATOLOGY_RULES.redFlags.urgent.join(' | ')}
Khám sớm: ${DERMATOLOGY_RULES.redFlags.soon.join(' | ')}

## V. CONFIDENCE RUBRIC (5 trục, mỗi trục 0–2 điểm)
- morphologyMatch: hình thái tổn thương khớp bao nhiêu
- distributionMatch: phân bố vị trí khớp bao nhiêu
- symptomMatch: triệu chứng chủ quan khớp bao nhiêu
- historyMatch: trigger/lịch sử khớp bao nhiêu
- exclusionScore: loại trừ được chẩn đoán gần nhất tốt đến đâu
→ High: 8–10 điểm | Moderate: 5–7 | Low: 0–4

## VI. DẤU HIỆU HÌNH THÁI ƯU TIÊN
${Object.entries(DERMATOLOGY_RULES.morphologySignals).map(([k, v]) =>
  `- ${k}: → ${v.condition} (${v.note})`
).join('\n')}
`;

    const structuredPrompt = `${rulesText}

══════════════════════════════════════════════
DỮ LIỆU ĐẦU VÀO TỪ NGƯỜI DÙNG
══════════════════════════════════════════════
[CHECKLIST TRIGGER]: ${checklistFlags.length > 0 ? checklistFlags.join('; ') : 'Không có'}
[CHECKLIST KHÁC]: ${checklist.notes || 'Không có'}

[MÔ TẢ TỪ ẢNH/NGƯỜI DÙNG]: ${imageDescription || 'Không có'}

[TRIỆU CHỨNG CHỦ QUAN]: ${symptomFlags.length > 0 ? symptomFlags.join('; ') : 'Không có'}
[MÔ TẢ CHI TIẾT]: ${symptoms.description || 'Không có'}
[THỜI GIAN XUẤT HIỆN]: ${symptoms.duration || 'Không rõ'}
[CÓ LAN KHÔNG]: ${symptoms.spreading || 'Không rõ'}
[SỐT]: ${symptoms.fever ? 'CÓ' : 'Không'}

══════════════════════════════════════════════
QUY TRÌNH PHÂN TÍCH BẮT BUỘC (7 BƯỚC)
══════════════════════════════════════════════
Bước A – Kiểm tra độ đủ dữ liệu: đủ sáng, đủ nét, đủ góc, có filter/makeup không, tóc có che vùng tổn thương không
Bước B – Mô tả hình thái từ ảnh TRƯỚC: comedone, sẩn đỏ, mụn mủ, nốt sâu, mảng đỏ, vảy khô, vảy nhờn vàng, trợt, đóng mày mật ong, dạng vòng, thương tổn đơn dạng hay đa dạng, dấu gãi/nặn, thâm hoặc sẹo
Bước C – Mô tả phân bố: trán, má, cằm, quanh miệng, quanh mũi, quanh mắt, chân tóc, lông mày, rãnh mũi má, tai, cổ, ngực/lưng; đối xứng hay lệch một bên; đúng vùng cọ xát/bí hay không
Bước D – Gắn triệu chứng chủ quan: ngứa → dermatitis/nấm/viêm nang lông do nấm men hơn acne; đau sâu → nốt viêm/nhiễm trùng; nóng rát → kích ứng, periorificial, rosacea-like
Bước E – Đối chiếu trigger/lối sống: stress, thiếu ngủ, đồ ngọt/sữa, mồ hôi, ma sát, routine quá nhiều hoạt chất, sản phẩm mới, steroid, hair products, thú cưng
Bước F – Loại trừ có hệ thống: mỗi chẩn đoán phải có bằng chứng ủng hộ VÀ ít nhất một lý do khiến chẩn đoán gần nhất kém phù hợp hơn
Bước G – Kết luận an toàn: chọn 01 tình trạng chính, chấm mức độ chắc chắn, nêu red flags và hướng xử lý phù hợp

Trả về JSON thuần, KHÔNG markdown, KHÔNG giải thích thêm:
{
  "data_quality": {
    "status": "adequate | limited | inadequate",
    "issues": ["Danh sách vấn đề nếu có"]
  },
  "image_findings": ["Mô tả những gì AI thực sự nhìn thấy từ dữ liệu đầu vào"],
  "history_flags": ["Trigger/lịch sử nổi bật"],
  "most_likely_condition": {
    "name": "Tên tình trạng khoanh vùng chính",
    "confidence": "low | moderate | high",
    "confidence_score": 0-10,
    "confidence_note": "Giải thích ngắn tại sao mức này",
    "severity": "mild | moderate | severe"
  },
  "alternatives": [
    { "name": "Chẩn đoán phân biệt 1", "reason_against": "Tại sao ít phù hợp hơn" }
  ],
  "reasoning_summary": "Tóm tắt logic: bằng chứng ưu tiên → loại trừ → kết luận",
  "self_care": ["Gợi ý an toàn, không kê đơn, cụ thể"],
  "red_flags": ["Dấu hiệu cần đi khám"],
  "seek_care": "self-care | routine-visit | soon | urgent | emergency",
  "additional_info_needed": ["Thông tin cần bổ sung nếu chưa đủ dữ liệu"],
  "teen_message": "Thông điệp trấn an cho học sinh, gần gũi, không hù dọa"
}
CHỈ trả JSON thuần.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-70b-versatile',
        max_tokens: 3500,
        temperature: 0.1,
        top_p: 0.85,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Bạn là EDUHEALTH AI Dermatology Screening Specialist – trợ lý sàng lọc da liễu học đường cho học sinh 15–18 tuổi.
PHẠM VI: Chỉ khoanh vùng các tình trạng da phổ biến học đường. KHÔNG chẩn đoán ung thư, sang thương sắc tố, bệnh nặng ngoài phạm vi.
Ưu tiên theo thứ tự: an toàn y khoa > trung thực về độ chắc chắn > logic lâm sàng > ngôn ngữ dễ hiểu > sự trấn an.
Không tự nhận là chẩn đoán xác định. Dùng "khoanh vùng phù hợp nhất" hoặc "nghi nhiều tới".
Luôn chọn 01 tình trạng chính. Tối đa 02 chẩn đoán phân biệt khi bằng chứng chồng lấn.
Không kê đơn. Không gợi ý corticoid khi chưa rõ bệnh. Không gợi isotretinoin, kháng sinh uống, thuốc chống nấm uống.
LUÔN trả RED FLAGS và ngưỡng chuyển khám. Thận trọng với trẻ nhỏ.
Trả JSON thuần – KHÔNG markdown – KHÔNG giải thích.`
          },
          { role: 'user', content: structuredPrompt }
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[/api/scan/v2] Groq error:', err);
      return res.status(502).json({ error: 'Lỗi AI. Vui lòng thử lại.' });
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content || '';

    let cleaned = rawText
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/gi, '')
      .replace(/^[^{]*/, '')
      .replace(/[^}]*$/, '')
      .trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[/api/scan/v2] JSON parse error:', parseError.message);
      console.error('Raw text:', rawText);
      return res.status(502).json({ error: 'AI trả về dữ liệu không hợp lệ. Vui lòng thử lại.' });
    }

    // Auto-inject red flags from rules engine if any match
    const allRedFlags = [
      ...DERMATOLOGY_RULES.redFlags.emergency,
      ...DERMATOLOGY_RULES.redFlags.urgent,
      ...DERMATOLOGY_RULES.redFlags.soon,
    ];

    // Override seek_care if emergency red flags detected in input
    let seekCare = result.seek_care || 'routine-visit';
    if (symptoms.emergency || symptoms.swelling_lips_tongue || symptoms.difficulty_breathing) {
      seekCare = 'emergency';
    }

    const defaultResult = {
      data_quality: {
        status: result.data_quality?.status || 'limited',
        issues: Array.isArray(result.data_quality?.issues) ? result.data_quality.issues : [],
      },
      image_findings: Array.isArray(result.image_findings) ? result.image_findings : ['Đang phân tích...'],
      history_flags: Array.isArray(result.history_flags) ? result.history_flags : checklistFlags,
      most_likely_condition: {
        name: result.most_likely_condition?.name || 'Cần khám để xác định',
        confidence: result.most_likely_condition?.confidence || 'low',
        confidence_score: result.most_likely_condition?.confidence_score || 0,
        confidence_note: result.most_likely_condition?.confidence_note || 'Dữ liệu chưa đủ để đánh giá',
        severity: result.most_likely_condition?.severity || 'moderate',
      },
      alternatives: Array.isArray(result.alternatives) ? result.alternatives : [],
      reasoning_summary: result.reasoning_summary || 'Đang phân tích...',
      self_care: Array.isArray(result.self_care) ? result.self_care : [
        'Rửa mặt dịu nhẹ tối đa 2 lần/ngày',
        'Dùng kem dưỡng ẩm không bít tắc (oil-free)',
        'Tránh chà xát, nặn mụn, thử nhiều sản phẩm cùng lúc',
        'Chống nắng khi ra ngoài',
      ],
      red_flags: Array.isArray(result.red_flags) && result.red_flags.length > 0
        ? result.red_flags
        : allRedFlags.filter(r => {
            const desc = (symptoms.description || '') + (imageDescription || '');
            return desc.toLowerCase().includes(r.split(' ')[0].toLowerCase());
          }),
      seek_care: seekCare,
      additional_info_needed: Array.isArray(result.additional_info_needed) ? result.additional_info_needed : [],
      teen_message: result.teen_message || 'Đừng quá lo, EduHealth AI đang giúp cậu khoanh vùng bước đầu. Nếu cần, hệ thống sẽ hướng cậu tới bác sĩ da liễu để kiểm tra kỹ hơn nhé.',
    };

    console.log(`[/api/scan/v2] Condition: ${defaultResult.most_likely_condition.name} | Confidence: ${defaultResult.most_likely_condition.confidence} | Seek care: ${seekCare}`);
    res.json(defaultResult);

  } catch (err) {
    console.error('[/api/scan/v2] Error:', err.message);
    res.status(500).json({ error: err.message || 'Lỗi server. Vui lòng thử lại.' });
  }
});

// ══════════════════════════════════════════════════════════════
// HOẠT ĐỘNG — CRUD cho bài đăng video / bài viết
// ══════════════════════════════════════════════════════════════

// GET /api/activity — Lấy danh sách bài đăng
app.get('/api/activity', async (req, res) => {
  try {
    if (pool && dbReady) {
      try {
        const result = await pool.query(
          `SELECT p.*,
            COALESCE(json_agg(
              json_build_object('id', c.id, 'authorName', c.author_name, 'authorRole', c.author_role,
                'content', c.content, 'createdAt', c.created_at, 'avatarColor', c.avatar_color)
              ORDER BY c.created_at ASC
            ) FILTER (WHERE c.id IS NOT NULL), '[]') as comments
          FROM activity_posts p
          LEFT JOIN activity_comments c ON c.post_id = p.id
          GROUP BY p.id
          ORDER BY p.created_at DESC
          LIMIT 50`
        );
        return res.json(result.rows.map(row => ({
          id: row.id,
          type: row.type,
          title: row.title,
          description: row.description,
          content: row.content,
          thumbnailUrl: row.thumbnail_url,
          authorName: row.author_name,
          authorRole: row.author_role,
          views: row.views,
          reactions: row.reactions || [],
          comments: row.comments || [],
          tags: row.tags || [],
          createdAt: row.created_at,
        })));
      } catch (dbErr) {
        console.error('[/api/activity GET] DB error, using in-memory:', dbErr.message);
      }
    }
    // Fallback to in-memory store - merge with stored posts
    const allPosts = [...inMemoryPosts];
    res.json(allPosts);
  } catch (err) {
    console.error('[/api/activity GET]', err.message);
    res.json(inMemoryPosts);
  }
});

// POST /api/activity — Tạo bài đăng mới
app.post('/api/activity', async (req, res) => {
  try {
    console.log('[/api/activity POST] Body:', JSON.stringify(req.body));
    const { type, title, description, content, thumbnailUrl, authorName, authorRole, tags } = req.body || {};
    if (!type || !title || !content || !authorName || !authorRole) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc.' });
    }
    // Normalize role - accept any reasonable role string (handles encoding issues)
    const roleStr = String(authorRole || '').trim();
    // Accept any role >= 3 chars (handles Vietnamese encoding issues)
    if (roleStr.length < 3) {
      console.log('[/api/activity POST] Invalid role:', authorRole);
      return res.status(403).json({ error: 'Vai trò không hợp lệ.' });
    }
    // Map to correct role based on Vietnamese characters (with encoding fallback)
    const roleLower = roleStr.toLowerCase();
    // Check for health worker indicators
    const isYTe = roleLower.includes('y') || roleLower.includes('b') || roleLower.includes('s');
    const normalizedRole = isYTe ? 'Cán bộ y tế' : 'Giáo viên';
    const reactions = [
      { type: 'like', count: 0, reacted: false },
      { type: 'love', count: 0, reacted: false },
      { type: 'wow', count: 0, reacted: false },
      { type: 'care', count: 0, reacted: false },
      { type: 'fire', count: 0, reacted: false },
    ];
    let newPost;
    if (pool && dbReady) {
      try {
        const result = await pool.query(
          `INSERT INTO activity_posts (type, title, description, content, thumbnail_url, author_name, author_role, reactions, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [type, title, description || '', content, thumbnailUrl || null, authorName, normalizedRole, JSON.stringify(reactions), tags || []]
        );
        const row = result.rows[0];
        newPost = {
          id: row.id, type: row.type, title: row.title, description: row.description,
          content: row.content, thumbnailUrl: row.thumbnail_url, authorName: row.author_name,
          authorRole: row.author_role, views: 0, reactions: row.reactions, comments: [],
          tags: row.tags || [], createdAt: row.created_at,
        };
        return res.json(newPost);
      } catch (dbErr) {
        console.error('[/api/activity POST] DB error, falling back to in-memory:', dbErr.message);
      }
    }
    // In-memory fallback
    newPost = { id: Date.now().toString(), type, title, description: description || '', content, thumbnailUrl: thumbnailUrl || '', authorName, authorRole: normalizedRole, views: 0, reactions, comments: [], tags: tags || [], createdAt: new Date().toISOString() };
    inMemoryPosts.unshift(newPost);
    res.json(newPost);
  } catch (err) {
    console.error('[/api/activity POST]', err.message);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// POST /api/activity/:id/react — React (like/love/wow/care/fire)
app.post('/api/activity/:id/react', async (req, res) => {
  try {
    const { id } = req.params;
    const { reactionType } = req.body;
    if (!['like','love','wow','care','fire','sad'].includes(reactionType)) {
      return res.status(400).json({ error: 'Loại reaction không hợp lệ.' });
    }
    if (pool && dbReady) {
      try {
        const postRes = await pool.query('SELECT reactions FROM activity_posts WHERE id = $1', [id]);
        if (!postRes.rows.length) return res.status(404).json({ error: 'Không tìm thấy bài.' });
        const reactions = postRes.rows[0].reactions || [];
        const idx = reactions.findIndex(r => r.type === reactionType);
        if (idx >= 0) { reactions[idx].count += 1; }
        else { reactions.push({ type: reactionType, count: 1, reacted: false }); }
        await pool.query('UPDATE activity_posts SET reactions = $1 WHERE id = $2', [JSON.stringify(reactions), id]);
        return res.json({ reactions });
      } catch (dbErr) {
        console.error('[/api/activity/react] DB error:', dbErr.message);
      }
    }
    // In-memory fallback
    const post = inMemoryPosts.find(p => p.id == id);
    if (!post) return res.status(404).json({ error: 'Không tìm thấy bài.' });
    const idx = post.reactions.findIndex(r => r.type === reactionType);
    if (idx >= 0) { post.reactions[idx].count += 1; } else { post.reactions.push({ type: reactionType, count: 1, reacted: false }); }
    res.json({ reactions: post.reactions });
  } catch (err) {
    console.error('[/api/activity/react]', err.message);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// POST /api/activity/:id/comment — Thêm bình luận
app.post('/api/activity/:id/comment', async (req, res) => {
  try {
    const { id } = req.params;
    const { authorName, authorRole, content } = req.body;
    if (!authorName || !content) return res.status(400).json({ error: 'Thiếu tên hoặc nội dung.' });
    const AVATAR_COLORS = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#0d9488'];
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const comment = { id: Date.now().toString(), authorName, authorRole: authorRole || 'Khách', content, createdAt: new Date().toISOString(), avatarColor };
    if (pool && dbReady) {
      try {
        const result = await pool.query(
          `INSERT INTO activity_comments (post_id, author_name, author_role, content, avatar_color)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [id, authorName, authorRole || 'Khách', content, avatarColor]
        );
        const row = result.rows[0];
        return res.json({ id: row.id, authorName: row.author_name, authorRole: row.author_role, content: row.content, createdAt: row.created_at, avatarColor: row.avatar_color });
      } catch (dbErr) {
        console.error('[/api/activity/comment] DB error:', dbErr.message);
      }
    }
    // In-memory fallback
    const post = inMemoryPosts.find(p => p.id == id);
    if (!post) return res.status(404).json({ error: 'Không tìm thấy bài.' });
    post.comments.push(comment);
    res.json(comment);
  } catch (err) {
    console.error('[/api/activity/comment]', err.message);
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// POST /api/activity/:id/view — Tăng lượt xem
app.post('/api/activity/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    if (pool && dbReady) {
      try {
        await pool.query('UPDATE activity_posts SET views = views + 1 WHERE id = $1', [id]);
      } catch (dbErr) {
        console.error('[/api/activity/view] DB error:', dbErr.message);
      }
    }
    // In-memory fallback
    const post = inMemoryPosts.find(p => p.id == id);
    if (post) post.views += 1;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true });
  }
});

// DELETE /api/activity/:id — Xóa bài đăng
app.delete('/api/activity/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (pool) {
      await pool.query('DELETE FROM activity_posts WHERE id = $1', [id]);
    } else {
      inMemoryPosts = inMemoryPosts.filter(p => p.id !== id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi server.' });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ EduHealth Proxy đang chạy tại http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Groq:   ${process.env.GROQ_API_KEY ? '✅ configured' : '❌ missing'}`);
});
