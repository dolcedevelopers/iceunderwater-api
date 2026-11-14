import PDFDocument from "pdfkit";
import type { RowDataPacket } from "mysql2";
import type { SessionLike } from "../authz/permissions.js";
import { getTransactionFor } from "./transactionService.js";
import { query } from "../db/pool.js";
import type { TransactionDto } from "../serializers/dto.js";

type InvoiceLine={name:string;quantity:number;line_total_cents:number};
export function renderInvoicePdf(invoice:TransactionDto,lines:InvoiceLine[]):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:"A4",margin:48,bufferPages:true,info:{Title:`ICE UNDERWATER Invoice ${invoice.reference}`,Author:"ICE UNDERWATER"}});
    const chunks:Buffer[]=[];doc.on("data",chunk=>chunks.push(chunk));doc.on("end",()=>resolve(Buffer.concat(chunks)));doc.on("error",reject);
    const money=(n:number)=>`R ${n.toFixed(2)}`;
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#132a43").text("ICE UNDERWATER");doc.moveDown(.3);
    doc.fontSize(16).text(`Invoice / receipt ${invoice.reference}`);doc.font("Helvetica").fontSize(10).fillColor("#4c6075").text(`Order ID: ${invoice.wooOrderId || invoice.reference}    Payment status: ${invoice.status.toUpperCase()}`);
    doc.text(`Issued: ${new Date(invoice.createdAt).toLocaleString("en-ZA",{timeZone:"Africa/Johannesburg"})} SAST`);doc.moveDown();
    doc.fillColor("#132a43").font("Helvetica-Bold").text("Supplier");doc.font("Helvetica").text(invoice.supplierName || "ICE UNDERWATER supplier");
    if(invoice.supplierAddress)doc.text(invoice.supplierAddress);if(invoice.supplierVatNumber)doc.text(`VAT number: ${invoice.supplierVatNumber}`);if(invoice.supplierRegistrationNumber)doc.text(`Registration: ${invoice.supplierRegistrationNumber}`);
    doc.moveDown().font("Helvetica-Bold").text("Billed to");doc.font("Helvetica").text(invoice.customerName||invoice.customerEmail).text(invoice.customerEmail);doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(11).text("Order items");doc.moveDown(.5);
    for(const line of lines){
      if(doc.y>690)doc.addPage();
      doc.font("Helvetica").fontSize(10).fillColor("#132a43").text(`${line.quantity} x ${line.name}`,48,doc.y,{width:365});
      doc.text(money(Number(line.line_total_cents)/100),420,doc.y-12,{width:125,align:"right"});doc.moveDown(.6);
    }
    if(!lines.length)doc.font("Helvetica").fontSize(10).text(`${invoice.items} item(s). Item details are not available in the app record.`);
    if(doc.y>630)doc.addPage();doc.moveDown();doc.font("Helvetica-Bold").fontSize(17).text(`Order total: ${money(invoice.total)}`,48,doc.y,{align:"right"});
    doc.moveDown().font("Helvetica").fontSize(9).fillColor("#4c6075").text("Amounts are in South African rand. The total follows the recorded transaction and may include charges beyond the item amounts. VAT is not separately itemised in this app record; contact the supplier if a detailed tax invoice is required.",48,doc.y,{width:499});
    doc.moveDown().text("Payment confirmation and physical delivery are separate. This document does not certify receipt of the goods.");
    const range=doc.bufferedPageRange();for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);doc.fontSize(8).text(`ICE UNDERWATER | ${i+1} / ${range.count}`,48,782,{lineBreak:false});}doc.end();
  });
}
export async function invoicePdfFor(session:SessionLike,id:string) {
  const invoice=await getTransactionFor(session,id);
  const scope=invoice.transactionType==="sale" ? invoice.supplierId : null;
  const lines=await query<(RowDataPacket & InvoiceLine)[]>(`SELECT name,quantity,line_total_cents FROM iuw_transaction_lines WHERE transaction_id=:id${scope?" AND supplier_id=:supplier":""} ORDER BY id`,{id,...(scope?{supplier:scope}:{})});
  const pdf=await renderInvoicePdf(invoice,lines);
  return {filename:`ICE-UNDERWATER-Invoice-${String(invoice.reference).replace(/[^a-zA-Z0-9-]/g,"-").slice(0,80)}.pdf`,mimeType:"application/pdf",base64:pdf.toString("base64")};
}
