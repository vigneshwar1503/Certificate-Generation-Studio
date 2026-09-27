import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { templateConfig } from './config/templateConfig.js';
import { getSettings } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Convert HEX color to pdf-lib RGB
const hexToRgb = (hex = '#000000') => {
  const cleanHex = hex.replace('#', '');

  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;

  return rgb(r, g, b);
};

// Get font
const getFont = async (pdfDoc, fontName, uploadsDir) => {
  try {
    if (fontName === 'Helvetica') {
      return await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

    if (fontName === 'Helvetica-Bold') {
      return await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    }

    if (fontName === 'Times-Roman') {
      return await pdfDoc.embedFont(StandardFonts.TimesRoman);
    }

    if (fontName === 'Times-Bold') {
      return await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    }

    if (fontName === 'Courier') {
      return await pdfDoc.embedFont(StandardFonts.Courier);
    }

    if (fontName === 'Courier-Bold') {
      return await pdfDoc.embedFont(StandardFonts.CourierBold);
    }

    // Custom font
    const fontPath = path.join(uploadsDir, 'fonts', fontName);

    if (fs.existsSync(fontPath)) {
      const fontBytes = fs.readFileSync(fontPath);
      return await pdfDoc.embedFont(fontBytes);
    }
  } catch (error) {
    console.error(`Error embedding font ${fontName}:`, error);
  }

  return await pdfDoc.embedFont(StandardFonts.Helvetica);
};

/**
 * Generate PDF
 *
 * This version DOES NOT require:
 *   templates/offer_letter_template.pdf
 *   templates/certificate_template.png
 *
 * If those files exist, they can still be used.
 * If they don't exist, a PDF is generated directly.
 */
export const generatePDF = async (
  data,
  docType,
  isPreview = false
) => {
  const settings = await getSettings();
  const config = templateConfig[docType];

  const uploadsDir = path.resolve(__dirname, '../uploads');
  const projectRootDir = path.resolve(__dirname, '..');

  if (!config) {
    throw new Error(`Invalid document type: ${docType}`);
  }

  // ---------------------------------------------------------
  // 1. CREATE PDF
  // ---------------------------------------------------------

  const pdfDoc = await PDFDocument.create();

  let width;
  let height;
  let page;

  // Default dimensions from templateConfig
  if (docType === 'certificate') {
    width = config.defaultWidth || 842;
    height = config.defaultHeight || 595;
  } else {
    width = config.defaultWidth || 595;
    height = config.defaultHeight || 842;
  }

  // ---------------------------------------------------------
  // 2. OPTIONAL TEMPLATE
  // ---------------------------------------------------------
  //
  // We try to use a template if one exists.
  // If it doesn't exist, we simply create a blank PDF.
  //

  let templatePath = null;

  const customTemplatePath =
    docType === 'offer_letter'
      ? settings?.offer_letter_template
      : settings?.certificate_template;

  if (customTemplatePath) {
    templatePath = path.resolve(projectRootDir, customTemplatePath);
  } else if (config.templatePath) {
    templatePath = path.resolve(projectRootDir, config.templatePath);
  }

  let templateLoaded = false;

  if (templatePath && fs.existsSync(templatePath)) {
    const fileExt = path.extname(templatePath).toLowerCase();

    try {
      // PDF template
      if (fileExt === '.pdf') {
        const templateBytes = fs.readFileSync(templatePath);

        const externalDoc = await PDFDocument.load(templateBytes);

        const [copiedPage] = await pdfDoc.copyPages(
          externalDoc,
          [0]
        );

        pdfDoc.addPage(copiedPage);

        page = pdfDoc.getPages()[0];

        const size = page.getSize();

        width = size.width;
        height = size.height;

        templateLoaded = true;
      }

      // PNG/JPG template
      else if (
        fileExt === '.png' ||
        fileExt === '.jpg' ||
        fileExt === '.jpeg'
      ) {
        const imageBytes = fs.readFileSync(templatePath);

        let bgImage;

        if (fileExt === '.png') {
          bgImage = await pdfDoc.embedPng(imageBytes);
        } else {
          bgImage = await pdfDoc.embedJpg(imageBytes);
        }

        width = config.defaultWidth || bgImage.width;
        height = config.defaultHeight || bgImage.height;

        page = pdfDoc.addPage([width, height]);

        page.drawImage(bgImage, {
          x: 0,
          y: 0,
          width,
          height
        });

        templateLoaded = true;
      }
    } catch (error) {
      console.warn(
        'Template could not be loaded. Using generated PDF instead:',
        error.message
      );
    }
  }

  // ---------------------------------------------------------
  // 3. FALLBACK PAGE
  // ---------------------------------------------------------

  if (!templateLoaded) {
    page = pdfDoc.addPage([width, height]);

    // White background
    page.drawRectangle({
      x: 0,
      y: 0,
      width,
      height,
      color: rgb(1, 1, 1)
    });

    // Add simple professional header
    const headerFont = await pdfDoc.embedFont(
      StandardFonts.HelveticaBold
    );

    const normalFont = await pdfDoc.embedFont(
      StandardFonts.Helvetica
    );

    if (docType === 'offer_letter') {
      page.drawText('STON TECHNOLOGY', {
        x: 50,
        y: height - 60,
        size: 22,
        font: headerFont,
        color: rgb(0.06, 0.18, 0.35)
      });

      page.drawText('INTERNSHIP OFFER LETTER', {
        x: 50,
        y: height - 95,
        size: 16,
        font: headerFont,
        color: rgb(0.15, 0.25, 0.4)
      });

      page.drawLine({
        start: {
          x: 50,
          y: height - 110
        },
        end: {
          x: width - 50,
          y: height - 110
        },
        thickness: 1,
        color: rgb(0.7, 0.7, 0.7)
      });
    } else {
      page.drawText('STON TECHNOLOGY', {
        x: 50,
        y: height - 60,
        size: 22,
        font: headerFont,
        color: rgb(0.06, 0.18, 0.35)
      });

      page.drawText('INTERNSHIP COMPLETION CERTIFICATE', {
        x: 50,
        y: height - 95,
        size: 16,
        font: headerFont,
        color: rgb(0.15, 0.25, 0.4)
      });

      page.drawLine({
        start: {
          x: 50,
          y: height - 110
        },
        end: {
          x: width - 50,
          y: height - 110
        },
        thickness: 1,
        color: rgb(0.7, 0.7, 0.7)
      });
    }
  }

  // ---------------------------------------------------------
  // 4. PREPARE VALUES
  // ---------------------------------------------------------

  const fields = config.fields || {};

  const values = {
    ...data,

    companyName:
      data.companyName ||
      settings?.company_name ||
      'Ston Technology',

    companyAddress:
      settings?.company_address || '',

    companyEmail:
      settings?.company_email || '',

    companyWebsite:
      settings?.company_website || '',

    companyPhone:
      settings?.company_phone || ''
  };

  // Certificate duration:
  // Convert months -> days
  if (
    docType === 'certificate' &&
    values.duration !== undefined &&
    values.duration !== null &&
    values.duration !== ''
  ) {
    const numericDuration = Number(values.duration);

    if (!Number.isNaN(numericDuration)) {
      values.duration = numericDuration * 30;
    }
  }

  // ---------------------------------------------------------
  // 5. INTERN ID
  // ---------------------------------------------------------

  if (data.internId !== undefined && data.internId !== null) {
    values.internId =
      docType === 'offer_letter'
        ? `INTERN-${data.internId}`
        : `CERT-${data.internId}`;
  }

  // ---------------------------------------------------------
  // 6. DRAW TEXT
  // ---------------------------------------------------------

  for (const [fieldName, fieldConfig] of Object.entries(fields)) {
    // Skip image fields
    if (fieldConfig.type === 'image') {
      continue;
    }

    const value = values[fieldName];

    if (
      value === undefined ||
      value === null ||
      value === ''
    ) {
      continue;
    }

    const textValue = String(value);

    const pdfX =
      (fieldConfig.x / 100) * width;

    const pdfY =
      ((100 - fieldConfig.y) / 100) * height;

    const font = await getFont(
      pdfDoc,
      fieldConfig.fontFamily || 'Helvetica',
      uploadsDir
    );

    const fontSize =
      fieldConfig.fontSize || 11;

    const color = hexToRgb(
      fieldConfig.color || '#000000'
    );

    const textWidth =
      font.widthOfTextAtSize(
        textValue,
        fontSize
      );

    let drawX = pdfX;

    if (fieldConfig.alignment === 'center') {
      drawX = pdfX - textWidth / 2;
    } else if (
      fieldConfig.alignment === 'right'
    ) {
      drawX = pdfX - textWidth;
    }

    const drawY =
      pdfY - fontSize * 0.8;

    // Only do whiteout when an actual template exists
    if (templateLoaded && docType === 'offer_letter') {
      const placeholderText =
        `{${fieldName}}`;

      const placeholderWidth =
        font.widthOfTextAtSize(
          placeholderText,
          fontSize
        );

      const boxWidth =
        Math.max(
          textWidth,
          placeholderWidth
        ) + 10;

      const boxHeight =
        fontSize + 6;

      let boxX = pdfX;

      if (
        fieldConfig.alignment === 'center'
      ) {
        boxX =
          pdfX - boxWidth / 2;
      } else if (
        fieldConfig.alignment === 'right'
      ) {
        boxX =
          pdfX - boxWidth + 5;
      } else {
        boxX = pdfX - 5;
      }

      page.drawRectangle({
        x: boxX,
        y: drawY - 4,
        width: boxWidth,
        height: boxHeight,
        color: rgb(1, 1, 1)
      });
    }

    // Draw text
    page.drawText(textValue, {
      x: drawX,
      y: drawY,
      size: fontSize,
      font,
      color
    });
  }

  // ---------------------------------------------------------
  // 7. FALLBACK DOCUMENT CONTENT
  // ---------------------------------------------------------

  // If no template exists, add readable document information.
  if (!templateLoaded) {
    const normalFont =
      await pdfDoc.embedFont(
        StandardFonts.Helvetica
      );

    const boldFont =
      await pdfDoc.embedFont(
        StandardFonts.HelveticaBold
      );

    let currentY =
      docType === 'offer_letter'
        ? height - 150
        : height - 150;

    const leftMargin = 60;

    const drawRow = (
      label,
      value
    ) => {
      if (
        value === undefined ||
        value === null ||
        value === ''
      ) {
        return;
      }

      page.drawText(`${label}:`, {
        x: leftMargin,
        y: currentY,
        size: 11,
        font: boldFont,
        color: rgb(0.15, 0.15, 0.15)
      });

      page.drawText(String(value), {
        x: leftMargin + 150,
        y: currentY,
        size: 11,
        font: normalFont,
        color: rgb(0.15, 0.15, 0.15)
      });

      currentY -= 30;
    };

    drawRow(
      'Intern ID',
      values.internId
    );

    drawRow(
      'Name',
      values.fullName
    );

    drawRow(
      'Role',
      values.role
    );

    drawRow(
      'Department',
      values.department
    );

    drawRow(
      'Duration',
      values.duration
    );

    drawRow(
      'Document Date',
      values.documentDate
    );

    if (docType === 'offer_letter') {
      drawRow(
        'Start Date',
        values.startDate
      );

      drawRow(
        'Internship Type',
        values.internshipType
      );

      drawRow(
        'Additional Notes',
        values.additional_notes ||
        values.additionalNotes
      );
    }

    if (docType === 'certificate') {
      drawRow(
        'Performance',
        values.performance_grade ||
        values.performanceGrade
      );

      drawRow(
        'Achievement',
        values.achievement_description ||
        values.achievementDescription
      );
    }

    page.drawLine({
      start: {
        x: leftMargin,
        y: currentY - 10
      },
      end: {
        x: width - leftMargin,
        y: currentY - 10
      },
      thickness: 1,
      color: rgb(0.75, 0.75, 0.75)
    });

    page.drawText(
      values.companyName,
      {
        x: leftMargin,
        y: currentY - 45,
        size: 12,
        font: boldFont,
        color: rgb(0.06, 0.18, 0.35)
      }
    );
  }

  // ---------------------------------------------------------
  // 8. QR CODE
  // ---------------------------------------------------------

  if (
    docType === 'certificate' &&
    fields.qrCode &&
    data.internId
  ) {
    try {
      const qrConfig =
        fields.qrCode;

      const verificationBaseUrl =
        settings?.verification_base_url ||
        'http://localhost:5173/verify';

      const verificationUrl =
        `${verificationBaseUrl}/${data.internId}`;

      const qrBuffer =
        await QRCode.toBuffer(
          verificationUrl,
          {
            margin: 1,
            width: 150,
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          }
        );

      const qrImage =
        await pdfDoc.embedPng(
          qrBuffer
        );

      const qrX =
        (qrConfig.x / 100) * width -
        qrConfig.width / 2;

      const qrY =
        ((100 - qrConfig.y) / 100) *
          height -
        qrConfig.height;

      page.drawImage(qrImage, {
        x: qrX,
        y: qrY,
        width: qrConfig.width,
        height: qrConfig.height
      });
    } catch (error) {
      console.error(
        'Failed to generate QR code:',
        error
      );
    }
  }

  // ---------------------------------------------------------
  // 9. CEO SIGNATURE
  // ---------------------------------------------------------

  if (
    fields.ceoSignature &&
    settings?.ceo_signature_path
  ) {
    const sigConfig =
      fields.ceoSignature;

    const sigFullPath =
      path.resolve(
        projectRootDir,
        settings.ceo_signature_path
      );

    if (fs.existsSync(sigFullPath)) {
      try {
        const sigBytes =
          fs.readFileSync(
            sigFullPath
          );

        const sigExt =
          path.extname(
            sigFullPath
          ).toLowerCase();

        let sigImage = null;

        if (sigExt === '.png') {
          sigImage =
            await pdfDoc.embedPng(
              sigBytes
            );
        } else if (
          sigExt === '.jpg' ||
          sigExt === '.jpeg'
        ) {
          sigImage =
            await pdfDoc.embedJpg(
              sigBytes
            );
        }

        if (sigImage) {
          const sigX =
            (sigConfig.x / 100) *
              width -
            sigConfig.width / 2;

          const sigY =
            ((100 - sigConfig.y) / 100) *
              height -
            sigConfig.height;

          page.drawImage(
            sigImage,
            {
              x: sigX,
              y: sigY,
              width: sigConfig.width,
              height: sigConfig.height
            }
          );
        }
      } catch (error) {
        console.error(
          'Failed to embed CEO signature:',
          error
        );
      }
    }
  }

  // ---------------------------------------------------------
  // 10. WATERMARK
  // ---------------------------------------------------------

  const watermarkEnabled =
    settings?.enable_draft_watermark === 1;

  if (watermarkEnabled) {
    const watermarkFont =
      await pdfDoc.embedFont(
        StandardFonts.HelveticaBold
      );

    const watermarkText =
      'DRAFT';

    const watermarkSize =
      Math.floor(
        Math.min(width, height) * 0.15
      );

    const watermarkWidth =
      watermarkFont.widthOfTextAtSize(
        watermarkText,
        watermarkSize
      );

    const watermarkHeight =
      watermarkFont.heightAtSize(
        watermarkSize
      );

    const allPages =
      pdfDoc.getPages();

    allPages.forEach((p) => {
      const pSize =
        p.getSize();

      p.drawText(
        watermarkText,
        {
          x:
            pSize.width / 2 -
            watermarkWidth / 2,

          y:
            pSize.height / 2 -
            watermarkHeight / 2,

          size: watermarkSize,

          font: watermarkFont,

          color: rgb(
            0.7,
            0.7,
            0.7
          ),

          opacity: 0.12,

          rotate: degrees(45)
        }
      );
    });
  }

  // ---------------------------------------------------------
  // 11. SAVE PDF
  // ---------------------------------------------------------

  const pdfBytes =
    await pdfDoc.save();

  return Buffer.from(pdfBytes);
};