<template>
	<v-row justify="center">
		<v-dialog
			v-model="dialog"
			max-width="480px"
			persistent
			transition="dialog-bottom-transition"
			class="offer-popup-dialog-content"
		>
			<v-card class="offer-popup-card" rounded="lg" elevation="12">
				<div class="offer-popup-header">
					<v-icon size="30" class="me-2">mdi-sale</v-icon>
					<span class="text-h6 font-weight-bold">{{ __("Offer Available") }}</span>
					<v-spacer></v-spacer>
					<v-btn
						icon="mdi-close"
						variant="text"
						size="small"
						density="comfortable"
						class="offer-popup-close"
						@click="dismissAll"
					></v-btn>
				</div>

				<v-card-text class="offer-popup-body">
					<transition-group name="offer-card" tag="div">
						<div
							v-for="offer in pendingOffers"
							:key="offer.name"
							class="offer-item-card"
							:class="offer.offer === 'Give Product' ? 'offer-item-gift' : 'offer-item-discount'"
						>
							<div class="offer-item-icon">
								<v-icon size="26">{{
									offer.offer === "Give Product" ? "mdi-gift-outline" : "mdi-tag-outline"
								}}</v-icon>
							</div>
							<div class="offer-item-body">
								<div class="offer-item-title">{{ offer.title || offer.name }}</div>
								<div v-if="offerHighlight(offer)" class="offer-item-highlight">
									{{ offerHighlight(offer) }}
								</div>
								<div v-if="offer.combo_items && offer.combo_items.length" class="offer-item-requires">
									{{ __("Requires") }}: {{ comboItemsLabel(offer) }}
								</div>
								<div
									v-if="offer.description"
									class="offer-item-desc"
									v-html="handleNewLine(offer.description)"
								></div>
								<div class="offer-item-actions">
									<v-btn
										color="success"
										size="default"
										variant="elevated"
										class="text-none"
										@click="applyOffer(offer)"
									>
										<v-icon start size="20">mdi-check-circle-outline</v-icon>
										{{ __("Apply Offer") }}
									</v-btn>
									<v-btn
										variant="tonal"
										size="default"
										class="text-none ms-1"
										@click="dismissOffer(offer)"
										>{{ __("Not Now") }}</v-btn
									>
								</div>
							</div>
						</div>
					</transition-group>
				</v-card-text>
			</v-card>
		</v-dialog>
	</v-row>
</template>

<script>
import format from "../../format";
/* global __ */
export default {
	mixins: [format],

	data: () => ({
		dialog: false,
		pendingOffers: [],
		pos_profile: {},
		allItems: [],
	}),

	methods: {
		applyOffer(offer) {
			this.eventBus.emit("apply_offer_from_popup", offer.name);
			this.removeFromPending(offer.name);
		},
		dismissOffer(offer) {
			this.removeFromPending(offer.name);
		},
		dismissAll() {
			this.pendingOffers = [];
			this.dialog = false;
		},
		removeFromPending(name) {
			this.pendingOffers = this.pendingOffers.filter((el) => el.name !== name);
			if (!this.pendingOffers.length) {
				this.dialog = false;
			}
		},
		handleNewLine(str) {
			if (str) {
				return str.replace(/(?:\r\n|\r|\n)/g, "<br />");
			}
			return "";
		},
		// Combo/give-item fields only ever carry item CODES (internal identifiers) --
		// resolve them against the item catalog for a customer-facing label, same as
		// every other item name shown in the POS UI.
		itemName(code) {
			if (!code) return "";
			const match = Array.isArray(this.allItems) ? this.allItems.find((el) => el.item_code === code) : null;
			return (match && match.item_name) || code;
		},
		comboItemsLabel(offer) {
			if (!Array.isArray(offer.combo_items)) return "";
			return offer.combo_items.map((el) => el.item_name || this.itemName(el.item_code)).join(" + ");
		},
		offerHighlight(offer) {
			if (offer.offer === "Give Product") {
				const qty = offer.given_qty || 1;
				const itemLabel = this.itemName(offer.give_item || offer.apply_item_code || "");
				return itemLabel ? `${__("Get")} ${qty} × ${itemLabel} ${__("FREE")}` : __("Free Item");
			}
			const symbol = this.currencySymbol(this.pos_profile.currency);
			if (offer.discount_type === "Discount Amount" && offer.discount_amount) {
				return `${symbol}${this.formatCurrency(offer.discount_amount)} ${__("OFF")}`;
			}
			if (offer.discount_type === "Discount Percentage" && offer.discount_percentage) {
				return `${offer.discount_percentage}% ${__("OFF")}`;
			}
			if (offer.discount_type === "Rate" && offer.rate != null && offer.rate !== "") {
				return `${__("Special Price")}: ${symbol}${this.formatCurrency(offer.rate)}`;
			}
			return "";
		},
	},

	created: function () {
		this.eventBus.on("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
		});
		this.eventBus.on("set_all_items", (data) => {
			this.allItems = data;
		});
		this.eventBus.on("offers_need_confirmation", (offers) => {
			offers.forEach((offer) => {
				if (!this.pendingOffers.find((el) => el.name === offer.name)) {
					this.pendingOffers.push(offer);
				}
			});
			if (this.pendingOffers.length) {
				this.dialog = true;
			}
		});
	},
};
</script>

<style scoped>
.offer-popup-card {
	overflow: hidden;
	background-color: var(--pos-card-bg, #fff);
	color: var(--pos-text-primary, #1a1a1a);
}

.offer-popup-header {
	display: flex;
	align-items: center;
	padding: 16px 20px;
	background: linear-gradient(135deg, var(--pos-primary, #1976d2), var(--pos-accent, #ff6b35));
	color: #fff;
}

.offer-popup-close {
	color: #fff !important;
}

.offer-popup-body {
	padding: 16px !important;
	max-height: 60vh;
	overflow-y: auto;
}

.offer-item-card {
	display: flex;
	align-items: flex-start;
	gap: 14px;
	padding: 14px;
	border-radius: 12px;
	background-color: var(--pos-surface-variant, #f8f9fa);
	border-inline-start: 4px solid var(--pos-success, #4caf50);
	box-shadow: 0 1px 4px var(--pos-shadow, rgba(0, 0, 0, 0.1));
	margin-bottom: 12px;
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.offer-item-card:hover {
	transform: translateY(-1px);
	box-shadow: 0 4px 10px var(--pos-shadow, rgba(0, 0, 0, 0.15));
}

.offer-item-card:last-child {
	margin-bottom: 0;
}

.offer-item-gift {
	border-inline-start-color: var(--pos-secondary, #00b894);
}

.offer-item-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	min-width: 44px;
	border-radius: 50%;
	background-color: var(--pos-success-container, #e8f5e9);
	color: var(--pos-success, #4caf50);
}

.offer-item-gift .offer-item-icon {
	background-color: var(--pos-secondary-container, #e0f7f2);
	color: var(--pos-secondary, #00b894);
}

.offer-item-body {
	flex: 1;
	min-width: 0;
}

.offer-item-title {
	font-weight: 700;
	font-size: 1rem;
	color: var(--pos-text-primary, #1a1a1a);
}

.offer-item-highlight {
	display: inline-block;
	margin-top: 4px;
	padding: 2px 10px;
	border-radius: 20px;
	font-weight: 700;
	font-size: 0.85rem;
	background-color: var(--pos-success-container, #e8f5e9);
	color: var(--pos-success, #4caf50);
}

.offer-item-gift .offer-item-highlight {
	background-color: var(--pos-secondary-container, #e0f7f2);
	color: var(--pos-secondary, #00b894);
}

.offer-item-requires {
	margin-top: 6px;
	font-size: 0.8rem;
	color: var(--pos-text-secondary, #757575);
}

.offer-item-desc {
	margin-top: 4px;
	font-size: 0.85rem;
	color: var(--pos-text-secondary, #757575);
}

.offer-item-actions {
	display: flex;
	align-items: center;
	margin-top: 10px;
}

.offer-card-enter-active,
.offer-card-leave-active {
	transition: all 0.25s ease;
}

.offer-card-enter-from {
	opacity: 0;
	transform: scale(0.92) translateY(6px);
}

.offer-card-leave-to {
	opacity: 0;
	transform: scale(0.92);
}

.offer-card-leave-active {
	position: absolute;
	width: calc(100% - 32px);
}
</style>

<style>
/* Unscoped: Vuetify teleports dialog overlays to a shared .v-overlay-container at <body>,
   outside this component's scoped styling. Without this, whichever overlay (this dialog vs.
   the item-search autocomplete's suggestion menu) happened to mount later wins the default
   z-index ordering -- so the search dropdown could render on top of this modal offer popup. */
.v-overlay.offer-popup-dialog-content {
	z-index: 3000 !important;
}
</style>
