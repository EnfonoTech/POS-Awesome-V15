/**
 * Enhanced print utilities for POSAwesome
 * Provides various printing options for invoices and documents
 */

/* global frappe */

/**
 * Print an invoice with various options
 * @param {Object} invoice - Invoice document
 * @param {Object} options - Print options 
 * @param {string} options.format - Print format (default: 'Standard')
 * @param {boolean} options.silent - Use silent printing (default: false)
 * @param {boolean} options.no_letterhead - Hide letterhead (default: false)
 * @param {string} options.letter_head - Letterhead to use
 * @param {Function} options.onSuccess - Success callback
 * @param {Function} options.onError - Error callback
 */
export function printInvoice(invoice, options = {}) {
	const {
		format = 'POS Invoice Print',
		silent = false,
		no_letterhead = false,
		letter_head = null,
		onSuccess = null,
		onError = null
	} = options;

	try {
		// Determine doctype based on invoice properties
		const doctype = invoice.doctype || 'POS Invoice';
		
	// Build print URL
	const baseUrl = frappe.urllib.get_base_url();
	const params = new URLSearchParams({
		doctype: doctype,
		name: invoice.name,
		format: format,
		no_letterhead: no_letterhead ? '1' : '0'
	});

		if (letter_head) {
			params.append('letter_head', letter_head);
		}

		const printUrl = `${baseUrl}/printview?${params.toString()}`;

	// Handle silent printing
	if (silent) {
		silentPrint(printUrl, options);
	} else {
		// Open in new window for regular printing
		const printWindow = window.open(printUrl, 'Print', 'width=1280,height=1024');
		
		if (printWindow) {
			printWindow.addEventListener('load', function() {
				printWindow.print();
				if (onSuccess) onSuccess();
			}, { once: true });

			printWindow.addEventListener('error', function() {
				if (onError) onError(new Error('Failed to load print window'));
			}, { once: true });
		} else {
			if (onError) onError(new Error('Failed to open print window'));
		}
	}

		return true;
	} catch (error) {
		console.error('Print error:', error);
		if (onError) onError(error);
		return false;
	}
}

/**
 * Download PDF of an invoice
 * @param {Object} invoice - Invoice document
 * @param {Object} options - Download options
 * @param {string} options.format - Print format (default: 'Standard')
 * @param {boolean} options.no_letterhead - Hide letterhead (default: false)
 * @param {string} options.letter_head - Letterhead to use
 */
export function downloadInvoicePDF(invoice, options = {}) {
	const {
		format = 'POS Invoice Print',
		no_letterhead = false,
		letter_head = null
	} = options;

	try {
		const doctype = invoice.doctype || 'POS Invoice';
		const baseUrl = frappe.urllib.get_base_url();
		
		const params = new URLSearchParams({
			doctype: doctype,
			name: invoice.name,
			format: format,
			no_letterhead: no_letterhead ? '1' : '0'
		});

		if (letter_head) {
			params.append('letter_head', letter_head);
		}

		const downloadUrl = `${baseUrl}/api/method/frappe.utils.print_format.download_pdf?${params.toString()}`;
		
		// Create a temporary link and trigger download
		const link = document.createElement('a');
		link.href = downloadUrl;
		link.download = `${invoice.name}.pdf`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);

		return true;
	} catch (error) {
		console.error('PDF download error:', error);
		return false;
	}
}

/**
 * Email an invoice
 * @param {Object} invoice - Invoice document
 * @param {Object} options - Email options
 * @param {string} options.recipients - Email recipients (comma-separated)
 * @param {string} options.subject - Email subject
 * @param {string} options.message - Email message
 * @param {string} options.format - Print format (default: 'Standard')
 */
export async function emailInvoice(invoice, options = {}) {
	const {
		recipients = '',
		subject = `Invoice ${invoice.name}`,
		message = 'Please find attached invoice.',
		format = 'Standard'
	} = options;

	try {
		const doctype = invoice.doctype || 'Sales Invoice';
		
		const response = await frappe.call({
			method: 'frappe.desk.form.utils.sendmail',
			args: {
				doctype: doctype,
				name: invoice.name,
				recipients: recipients,
				subject: subject,
				message: message,
				print_format: format
			}
		});

		return response.message;
	} catch (error) {
		console.error('Email error:', error);
		throw error;
	}
}

/**
 * Batch print multiple invoices
 * @param {Array} invoices - Array of invoice documents
 * @param {Object} options - Print options
 * @param {number} options.delay - Delay between prints in ms (default: 1000)
 * @param {Function} options.onProgress - Progress callback (index, total)
 * @param {Function} options.onComplete - Completion callback
 * @param {Function} options.onError - Error callback
 */
export function batchPrintInvoices(invoices, options = {}) {
	const {
		delay = 1000,
		onProgress = null,
		onComplete = null,
		onError = null
	} = options;

	let currentIndex = 0;

	function printNext() {
		if (currentIndex >= invoices.length) {
			if (onComplete) onComplete();
			return;
		}

		const invoice = invoices[currentIndex];
		
		if (onProgress) {
			onProgress(currentIndex + 1, invoices.length);
		}

		printInvoice(invoice, {
			...options,
			onSuccess: () => {
				currentIndex++;
				setTimeout(printNext, delay);
			},
			onError: (error) => {
				if (onError) onError(error, invoice, currentIndex);
				currentIndex++;
				setTimeout(printNext, delay);
			}
		});
	}

	printNext();
}

/**
 * Get available print formats for a doctype
 * @param {string} doctype - Document type
 * @returns {Promise<Array>} Array of print formats
 */
export async function getPrintFormats(doctype) {
	try {
		const response = await frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Print Format',
				filters: {
					doc_type: doctype,
					disabled: 0
				},
				fields: ['name', 'title', 'default_print_language'],
				order_by: 'title'
			}
		});

		return response.message || [];
	} catch (error) {
		console.error('Error fetching print formats:', error);
		return [];
	}
}

/**
 * Get available letterheads
 * @returns {Promise<Array>} Array of letterheads
 */
export async function getLetterheads() {
	try {
		const response = await frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Letter Head',
				filters: {
					disabled: 0
				},
				fields: ['name', 'title'],
				order_by: 'title'
			}
		});

		return response.message || [];
	} catch (error) {
		console.error('Error fetching letterheads:', error);
		return [];
	}
}

/**
 * Silent print function (imported from existing print.js)
 * @param {string} url - URL to print
 * @param {Object} options - Print options including posProfile
 */
function silentPrint(url, options = {}) {
	if (!url) return;
	
	const { posProfile } = options;
	const kioskPrintingEnabled = posProfile?.posa_kiosk_printing_mode || false;
	
	try {
		const iframe = document.createElement("iframe");
		iframe.style.position = "fixed";
		iframe.style.right = "0";
		iframe.style.bottom = "0";
		iframe.style.width = "0";
		iframe.style.height = "0";
		iframe.style.border = "0";
		iframe.onload = () => {
			try {
				iframe.contentWindow.focus();
				// Skip calling print() if kiosk printing mode is enabled in POS Profile
				if (!kioskPrintingEnabled) {
					iframe.contentWindow.print();
				}
			} finally {
				setTimeout(() => iframe.remove(), 1000);
			}
		};
		iframe.src = url;
		document.body.appendChild(iframe);
	} catch (err) {
		console.error("Silent print failed, falling back to new window", err);
		const win = window.open(url, "_blank");
		if (win && !kioskPrintingEnabled) {
			win.addEventListener("load", () => win.print(), { once: true });
		}
	}
}

/**
 * Print preview function
 * @param {Object} invoice - Invoice document
 * @param {Object} options - Print options
 */
export function printPreview(invoice, options = {}) {
	const {
		format = 'POS Invoice Print',
		no_letterhead = false,
		letter_head = null
	} = options;

	try {
		const doctype = invoice.doctype || 'POS Invoice';
		const baseUrl = frappe.urllib.get_base_url();
		
		const params = new URLSearchParams({
			doctype: doctype,
			name: invoice.name,
			format: format,
			no_letterhead: no_letterhead ? '1' : '0'
		});

		if (letter_head) {
			params.append('letter_head', letter_head);
		}

		const previewUrl = `${baseUrl}/printview?${params.toString()}`;
		
		// Open in new window for preview
		window.open(previewUrl, 'PrintPreview', 'width=1280,height=1024,scrollbars=yes,resizable=yes');
		
		return true;
	} catch (error) {
		console.error('Print preview error:', error);
		return false;
	}
}