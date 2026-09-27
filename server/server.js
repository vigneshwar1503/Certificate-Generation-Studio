import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

import {
  initDB,
  get,
  getSettings,
  updateSettings,
  getNextInternId,
  incrementInternId,
  addRecord,
  updateRecord,
  getRecordById,
  getRecordByInternId,
  searchRecords,
  getAuditLogs,
  checkDuplicate,
  logAction
} from './db.js';
import { generatePDF } from './pdfGenerator.js';
import { runBackup, initBackupService } from './backupService.js';
import cloudinaryService from './services/cloudinaryService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Set up directory structure
const projectRootDir = path.resolve(__dirname, '..');
const dirs = [
  'database',
  'templates',
  'generated',
  'generated/offer-letters',
  'generated/certificates',
  'uploads',
  'uploads/logos',
  'uploads/signatures',
  'uploads/fonts',
  'uploads/temp',
  'assets'
];

dirs.forEach((dir) => {
  const p = path.join(projectRootDir, dir);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
});

// Serve uploaded and generated assets statically
app.use('/uploads', express.static(path.join(projectRootDir, 'uploads')));
app.use('/generated', express.static(path.join(projectRootDir, 'generated')));

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'logo') {
      cb(null, path.join(projectRootDir, 'uploads/logos'));
    } else if (file.fieldname === 'signature') {
      cb(null, path.join(projectRootDir, 'uploads/signatures'));
    } else if (file.fieldname === 'font') {
      cb(null, path.join(projectRootDir, 'uploads/fonts'));
    } else if (file.fieldname === 'template') {
      cb(null, path.join(projectRootDir, 'templates'));
    } else {
      cb(null, path.join(projectRootDir, 'uploads/temp'));
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${file.fieldname}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// --- API ROUTES ---

// 1. Settings Endpoints
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const settings = await updateSettings(req.body);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Settings assets uploads
app.post('/api/settings/upload', upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'signature', maxCount: 1 },
  { name: 'font', maxCount: 1 },
  { name: 'template', maxCount: 1 }
]), async (req, res) => {
  try {
    const updates = {};
    const files = req.files;

    if (files.logo) {
      updates.company_logo_path = `uploads/logos/${files.logo[0].filename}`;
      await logAction('UPLOAD_LOGO', `Uploaded company logo: ${files.logo[0].originalname}`);
    }

    if (files.signature) {
      updates.ceo_signature_path = `uploads/signatures/${files.signature[0].filename}`;
      await logAction('UPLOAD_SIGNATURE', `Uploaded CEO signature: ${files.signature[0].originalname}`);
    }

    let customFontName = null;
    if (files.font) {
      customFontName = files.font[0].filename;
      await logAction('UPLOAD_FONT', `Uploaded custom font: ${files.font[0].originalname}`);
    }

    let customTemplateInfo = null;
    if (files.template) {
      const type = req.body.type; // 'offer_letter' or 'certificate'
      const relativePath = `templates/${files.template[0].filename}`;
      
      if (type === 'offer_letter') {
        updates.offer_letter_template = relativePath;
      } else if (type === 'certificate') {
        updates.certificate_template = relativePath;
      }
      
      customTemplateInfo = { type, path: relativePath };
      await logAction('TEMPLATE_CHANGE', `Uploaded new template for ${type}: ${files.template[0].originalname}`);
    }

    if (Object.keys(updates).length > 0) {
      await updateSettings(updates);
    }

    res.json({
      success: true,
      updates,
      font: customFontName,
      template: customTemplateInfo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Live Preview Generation (Generates PDF without DB changes or ID increments)
app.post('/api/generate/preview', async (req, res) => {
  try {
    const { documentType, ...formData } = req.body;
    
    if (!documentType) {
      return res.status(400).json({ error: 'documentType is required' });
    }

    // Mock an ID for preview purposes
    formData.internId = formData.internId || '200X';

    const pdfBuffer = await generatePDF(formData, documentType, true);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=preview.pdf');
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Preview PDF generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Document Generation & Save Record
app.post('/api/generate', async (req, res) => {
  try {
    const formData = req.body;

    // Duplicate Warn override check
    const bypassDuplicate = req.body.bypassDuplicate === true;
    if (!bypassDuplicate) {
      const duplicate = await checkDuplicate(formData.fullName, formData.role);
      if (duplicate) {
        return res.json({
          duplicate: true,
          message: `An intern named "${formData.fullName}" with the role "${formData.role}" already exists. Do you want to generate a duplicate?`
        });
      }
    }

    // Allocate next Intern ID (sequential, stored in DB)
    const internId = await incrementInternId();
    formData.internId = internId;

    // --- Generate Offer Letter ---
    const offerPdfBuffer = await generatePDF(formData, 'offer_letter', false);
    const offerFilename = `INTERN-${internId}.pdf`;
    const offerRelativePath = `generated/offer-letters/${offerFilename}`;
    const offerAbsolutePath = path.join(projectRootDir, offerRelativePath);
    fs.writeFileSync(offerAbsolutePath, offerPdfBuffer);

    const offerCloudinaryUrl = await cloudinaryService.uploadPdfBuffer(offerPdfBuffer);

    const offerAdditionalDetails = {
      internshipType: formData.internshipType || 'Unpaid',
      additionalNotes: formData.additionalNotes || '',
      cloudinaryUrl: offerCloudinaryUrl
    };

    const offerRecordId = await addRecord({
      intern_id: internId,
      full_name: formData.fullName,
      role: formData.role,
      department: formData.department || '',
      document_type: 'offer_letter',
      duration: formData.duration,
      document_date: formData.documentDate,
      pdf_location: offerRelativePath,
      offer_letter_pdf: offerCloudinaryUrl,
      status: 'Active',
      additional_details: JSON.stringify(offerAdditionalDetails)
    });

    // --- Generate Certificate ---
    const certPdfBuffer = await generatePDF(formData, 'certificate', false);
    const certFilename = `CERT-${internId}.pdf`;
    const certRelativePath = `generated/certificates/${certFilename}`;
    const certAbsolutePath = path.join(projectRootDir, certRelativePath);
    fs.writeFileSync(certAbsolutePath, certPdfBuffer);

    const certCloudinaryUrl = await cloudinaryService.uploadPdfBuffer(certPdfBuffer);

    const certAdditionalDetails = {
      performanceGrade: formData.performanceGrade || '',
      achievementDescription: formData.achievementDescription || '',
      cloudinaryUrl: certCloudinaryUrl
    };

    const certRecordId = await addRecord({
      intern_id: internId,
      full_name: formData.fullName,
      role: formData.role,
      department: formData.department || '',
      document_type: 'certificate',
      duration: formData.duration,
      document_date: formData.documentDate,
      pdf_location: certRelativePath,
      certificate_pdf: certCloudinaryUrl,
      status: 'Completed',
      additional_details: JSON.stringify(certAdditionalDetails)
    });

    res.json({
      success: true,
      internId,
      offerRecordId,
      certRecordId,
      offerUrl: `/${offerRelativePath}`,
      certUrl: `/${certRelativePath}`
    });
  } catch (error) {
    console.error('Generate PDF error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Duplicate Check helper
app.get('/api/records/check-duplicate', async (req, res) => {
  try {
    const { name, role } = req.query;
    if (!name || !role) {
      return res.status(400).json({ error: 'name and role are required' });
    }
    const duplicate = await checkDuplicate(name, role);
    res.json({ duplicate: !!duplicate, record: duplicate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Records Dashboard and Searching
app.get('/api/records', async (req, res) => {
  try {
    const { search, document_type, status, date, page, limit } = req.query;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;

    const data = await searchRecords({ search, document_type, status, date }, pageNum, limitNum);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard stats endpoint
app.get('/api/records/stats', async (req, res) => {
  try {
    const stats = {};
    const settings = await getSettings();
    
    // Quick count aggregates
    const db = await getSettings(); // settings check
    const totalCount = await get('SELECT COUNT(*) as count FROM intern_records');
    const offerLetterCount = await get('SELECT COUNT(*) as count FROM intern_records WHERE document_type = "offer_letter"');
    const certCount = await get('SELECT COUNT(*) as count FROM intern_records WHERE document_type = "certificate"');
    const activeCount = await get('SELECT COUNT(*) as count FROM intern_records WHERE status = "Active"');

    res.json({
      total: totalCount ? totalCount.count : 0,
      offerLetters: offerLetterCount ? offerLetterCount.count : 0,
      certificates: certCount ? certCount.count : 0,
      active: activeCount ? activeCount.count : 0,
      nextInternId: settings.next_intern_id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/records/:id', async (req, res) => {
  try {
    const record = await getRecordById(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reprint: Stream file from disk
app.get('/api/records/:id/download', async (req, res) => {
  try {
    const record = await getRecordById(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const pdfPath = path.resolve(projectRootDir, record.pdf_location);
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: 'PDF file not found on disk' });
    }

    await logAction('DOWNLOAD_PDF', `Downloaded existing PDF for Intern ID: ${record.intern_id}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${path.basename(pdfPath)}`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit & Regenerate PDF without changing the Intern ID
app.post('/api/records/:id/regenerate', async (req, res) => {
  try {
    const recordId = req.params.id;
    const existingRecord = await getRecordById(recordId);

    if (!existingRecord) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const formData = req.body;
    
    // Inject the existing numeric Intern ID
    formData.internId = existingRecord.intern_id;
    const documentType = existingRecord.document_type;

    // Generate PDF with updated fields
    const pdfBuffer = await generatePDF(formData, documentType, false);

    // Save file (will overwrite the old one)
    const pdfPath = path.resolve(projectRootDir, existingRecord.pdf_location);
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Update database record details
    const additionalDetails = {};
    if (documentType === 'offer_letter') {
      additionalDetails.internshipType = formData.internshipType || 'Unpaid';
      additionalDetails.additionalNotes = formData.additionalNotes || '';
    } else {
      additionalDetails.performanceGrade = formData.performanceGrade || '';
      additionalDetails.achievementDescription = formData.achievementDescription || '';
    }

    await updateRecord(recordId, {
      full_name: formData.fullName,
      role: formData.role,
      department: formData.department || '',
      duration: formData.duration,
      document_date: formData.documentDate,
      status: formData.status || existingRecord.status,
      additional_details: JSON.stringify(additionalDetails)
    });

    res.json({
      success: true,
      recordId: existingRecord.id,
      internId: existingRecord.intern_id,
      pdfUrl: `/${existingRecord.pdf_location}`
    });
  } catch (error) {
    console.error('Regenerate PDF error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Bulk Import CSV/Excel & Batch Generation
app.post('/api/records/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const docType = req.body.documentType; // 'offer_letter' or 'certificate'
    if (!docType || (docType !== 'offer_letter' && docType !== 'certificate')) {
      return res.status(400).json({ error: 'Valid documentType is required ("offer_letter" or "certificate")' });
    }

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    // Cleanup uploaded file after loading workbook
    fs.unlinkSync(filePath);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Uploaded file contains no records' });
    }

    const results = {
      total: rows.length,
      success: 0,
      failed: 0,
      errors: []
    };

    const settings = await getSettings();

    for (const [index, row] of rows.entries()) {
      try {
        // Map synonyms case-insensitively
        const getVal = (synonyms) => {
          for (const key of Object.keys(row)) {
            if (synonyms.includes(key.toLowerCase().trim())) {
              return row[key];
            }
          }
          return '';
        };

        const fullName = getVal(['full name', 'fullname', 'name', 'intern name', 'student name']);
        const role = getVal(['role', 'position', 'internship role', 'job title']);
        const department = getVal(['department', 'dept']);
        const duration = getVal(['duration', 'internship duration', 'period', 'months']);
        const documentDate = getVal(['date', 'document date', 'offer date', 'cert date', 'issue date']);
        const internshipType = getVal(['type', 'internship type', 'paid/unpaid', 'paid', 'unpaid']) || 'Unpaid';
        const performanceGrade = getVal(['grade', 'performance grade', 'performance']) || 'Outstanding';
        const achievementDescription = getVal(['achievement', 'achievement description', 'achievements']) || '';
        
        if (!fullName || !role || !duration || !documentDate) {
          results.failed++;
          results.errors.push(`Row ${index + 1}: Missing required fields (Name, Role, Duration, Date)`);
          continue;
        }

        // Allocate next ID
        const internId = await incrementInternId();

        const formData = {
          internId,
          fullName,
          role,
          department,
          duration,
          documentDate,
          companyName: settings.company_name,
          internshipType,
          performanceGrade,
          achievementDescription
        };

        // Generate PDF
        const pdfBuffer = await generatePDF(formData, docType, false);

        // Save PDF file
        const prefix = docType === 'offer_letter' ? 'INTERN' : 'CERT';
        const folder = docType === 'offer_letter' ? 'offer-letters' : 'certificates';
        const filename = `${prefix}-${internId}.pdf`;
        const relativePdfPath = `generated/${folder}/${filename}`;
        const absolutePdfPath = path.join(projectRootDir, relativePdfPath);

        fs.writeFileSync(absolutePdfPath, pdfBuffer);

        // Save DB record
        const additionalDetails = {};
        if (docType === 'offer_letter') {
          additionalDetails.internshipType = internshipType;
          additionalDetails.additionalNotes = '';
        } else {
          additionalDetails.performanceGrade = performanceGrade;
          additionalDetails.achievementDescription = achievementDescription;
        }

        await addRecord({
          intern_id: internId,
          full_name: fullName,
          role: role,
          department: department,
          document_type: docType,
          duration: duration,
          document_date: documentDate,
          pdf_location: relativePdfPath,
          status: docType === 'offer_letter' ? 'Active' : 'Completed',
          additional_details: JSON.stringify(additionalDetails)
        });

        results.success++;
      } catch (rowError) {
        results.failed++;
        results.errors.push(`Row ${index + 1}: ${rowError.message}`);
      }
    }

    await logAction('BULK_IMPORT', `Bulk generated documents via file import. Success: ${results.success}, Failed: ${results.failed}`);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Public verification portal
app.get('/api/verify/:internId', async (req, res) => {
  try {
    const rawId = parseInt(req.params.internId);
    if (isNaN(rawId)) {
      return res.status(400).json({ error: 'Invalid Intern ID format' });
    }

    const record = await getRecordByInternId(rawId);
    if (!record) {
      return res.status(404).json({ error: 'Document not verified or not found in our directory.' });
    }

    const additionalDetails = JSON.parse(record.additional_details || '{}');
    const settings = await getSettings();

    res.json({
      verified: true,
      internId: record.intern_id,
      fullName: record.full_name,
      role: record.role,
      department: record.department,
      documentType: record.document_type,
      duration: record.duration,
      documentDate: record.document_date,
      status: record.status,
      companyName: settings.company_name,
      verificationDate: record.created_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Audit Logs Endpoint
app.get('/api/audit-logs', async (req, res) => {
  try {
    const logs = await getAuditLogs(200); // return last 200 logs
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 9. Manual DB Backup Trigger
app.post('/api/backup', async (req, res) => {
  try {
    const backupPath = await runBackup();
    if (!backupPath) {
      return res.status(500).json({ error: 'Failed to run backup' });
    }
    res.json({ success: true, file: path.basename(backupPath) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SERVER STARTUP ---

const startServer = async () => {
  try {
    await initDB();
    console.log('Database initialized successfully.');

    initBackupService();
    console.log('Automated backup service scheduled.');

    app.listen(PORT, () => {
      console.log(`Ston Document Generator API server listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
