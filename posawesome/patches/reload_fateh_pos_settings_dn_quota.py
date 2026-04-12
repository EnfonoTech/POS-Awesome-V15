import frappe


def execute():
    frappe.reload_doc("posawesome", "doctype", "fateh_pos_settings")
