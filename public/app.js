const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const urlParams = new URLSearchParams(window.location.search);
const requestedMode = urlParams.get("mode"); // 'admin' o 'client'

let tgUser = tg?.initDataUnsafe?.user || {
  id: 0,
  first_name: "Invitado",
  username: "prueba_local"
};

let supabaseClient = null;
let products = [];
let cart = new Map();
let isAdmin = false;

const els = {
  userBadge: document.getElementById("userBadge"),
  navTabs: document.getElementById("navTabs"),
  tabClient: document.getElementById("tabClient"),
  tabAdmin: document.getElementById("tabAdmin"),
  clientView: document.getElementById("clientView"),
  adminView: document.getElementById("adminView"),
  accessDeniedView: document.getElementById("accessDeniedView"),
  btnBackToClient: document.getElementById("btnBackToClient"),
  menuList: document.getElementById("menuList"),
  cartItems: document.getElementById("cartItems"),
  cartTotal: document.getElementById("cartTotal"),
  btnCheckout: document.getElementById("btnCheckout"),
  deliveryType: document.getElementById("deliveryType"),
  addressInput: document.getElementById("addressInput"),
  notesInput: document.getElementById("notesInput"),
  orderFeedback: document.getElementById("orderFeedback"),
  adminOrders: document.getElementById("adminOrders"),
  adminProducts: document.getElementById("adminProducts")
};

async function init() {
  const res = await fetch("/api/config");
  const config = await res.json();

  // Verificación segura con el backend
  if (tg?.initData) {
    const authRes = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg.initData })
    });
    const authData = await authRes.json();
    if (authData.authorized) {
      tgUser = authData.user;
      isAdmin = Boolean(authData.isAdmin);
    }
  }

  els.userBadge.textContent = `Hola, ${tgUser.first_name} (ID: ${tgUser.id})`;

  if (isAdmin) {
    els.navTabs.classList.remove("hidden");
  }

  supabaseClient = window.supabase.createClient(
    config.supabaseUrl,
    config.supabaseAnonKey
  );

  bindEvents();
  await loadProducts();

  if (requestedMode === "admin") {
    if (isAdmin) {
      switchTab("admin");
      await loadAdminOrders();
    } else {
      showAccessDenied();
    }
  } else {
    switchTab("client");
  }

  subscribeRealtime();
}

function bindEvents() {
  els.tabClient.addEventListener("click", () => switchTab("client"));
  els.tabAdmin.addEventListener("click", async () => {
    if (!isAdmin) {
      showAccessDenied();
      return;
    }
    switchTab("admin");
    await loadAdminOrders();
  });
  els.btnBackToClient?.addEventListener("click", () => switchTab("client"));
  els.btnCheckout.addEventListener("click", submitOrder);
}

function showAccessDenied() {
  els.clientView.classList.add("hidden");
  els.adminView.classList.add("hidden");
  els.accessDeniedView?.classList.remove("hidden");
}

function switchTab(tab) {
  els.accessDeniedView?.classList.add("hidden");
  const showAdmin = tab === "admin" && isAdmin;
  els.clientView.classList.toggle("hidden", showAdmin);
  els.adminView.classList.toggle("hidden", !showAdmin);
  els.tabClient.classList.toggle("active", !showAdmin);
  els.tabAdmin.classList.toggle("active", showAdmin);
}

async function loadProducts() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) {
    els.menuList.innerHTML = `<p class="muted">Error cargando menú: ${error.message}</p>`;
    return;
  }

  products = data || [];
  renderClientMenu();
  if (isAdmin) renderAdminProducts();
}

function renderClientMenu() {
  const available = products.filter((p) => p.is_available);
  if (!available.length) {
    els.menuList.innerHTML = `<p class="muted">No hay productos disponibles por el momento.</p>`;
    return;
  }

  els.menuList.innerHTML = available
    .map(
      (p) => `
      <div class="card product-card">
        <div>
          <h3>${escapeHtml(p.name)}</h3>
          <p class="muted">${escapeHtml(p.description || "")}</p>
        </div>
        <div class="price-row">
          <strong>$${Number(p.price).toFixed(2)}</strong>
          <button class="btn-primary" onclick="addToCart('${p.id}')">Agregar</button>
        </div>
      </div>
    `
    )
    .join("");
}

window.addToCart = function (productId) {
  const product = products.find((p) => p.id === productId);
  if (!product || !product.is_available) return;

  const existing = cart.get(productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.set(productId, { product, quantity: 1 });
  }
  renderCart();
};

window.changeQty = function (productId, delta) {
  const item = cart.get(productId);
  if (!item) return;
  const nextQty = item.quantity + delta;
  if (nextQty <= 0) {
    cart.delete(productId);
  } else {
    item.quantity = nextQty;
  }
  renderCart();
};

function renderCart() {
  const items = Array.from(cart.values());
  if (!items.length) {
    els.cartItems.innerHTML = `<p class="muted">Tu carrito está vacío.</p>`;
    els.cartTotal.textContent = "0.00";
    els.btnCheckout.disabled = true;
    return;
  }

  let total = 0;
  els.cartItems.innerHTML = items
    .map(({ product, quantity }) => {
      const subtotal = Number(product.price) * quantity;
      total += subtotal;
      return `
        <div class="row-between" style="margin-bottom: 8px;">
          <span>${quantity}x ${escapeHtml(product.name)} ($${subtotal.toFixed(2)})</span>
          <div>
            <button onclick="changeQty('${product.id}', -1)">-</button>
            <button onclick="changeQty('${product.id}', 1)">+</button>
          </div>
        </div>
      `;
    })
    .join("");

  els.cartTotal.textContent = total.toFixed(2);
  els.btnCheckout.disabled = false;
}

async function submitOrder() {
  const items = Array.from(cart.values());
  if (!items.length) return;

  const deliveryType = els.deliveryType.value;
  const address = els.addressInput.value.trim();
  const notes = els.notesInput.value.trim();

  if (deliveryType === "delivery" && !address) {
    els.orderFeedback.textContent = "Por favor escribe tu dirección de entrega.";
    return;
  }

  els.btnCheckout.disabled = true;
  els.orderFeedback.textContent = "Enviando pedido...";

  const total = items.reduce(
    (acc, { product, quantity }) => acc + Number(product.price) * quantity,
    0
  );

  const { data: order, error: orderError } = await supabaseClient
    .from("orders")
    .insert({
      tg_user_id: tgUser.id || 0,
      tg_username: tgUser.username || "",
      customer_name: tgUser.first_name || "Cliente",
      delivery_type: deliveryType,
      address,
      total,
      status: "pending",
      notes
    })
    .select()
    .single();

  if (orderError) {
    els.orderFeedback.textContent = `Error al crear pedido: ${orderError.message}`;
    els.btnCheckout.disabled = false;
    return;
  }

  const rows = items.map(({ product, quantity }) => ({
    order_id: order.id,
    product_id: product.id,
    product_name: product.name,
    unit_price: Number(product.price),
    quantity,
    subtotal: Number(product.price) * quantity
  }));

  const { error: itemsError } = await supabaseClient
    .from("order_items")
    .insert(rows);

  if (itemsError) {
    els.orderFeedback.textContent = `Pedido creado con folio #${order.order_number}, pero hubo un detalle en artículos.`;
  } else {
    els.orderFeedback.textContent = `¡Pedido #${order.order_number} enviado! Total: $${total.toFixed(2)}`;
    cart.clear();
    els.addressInput.value = "";
    els.notesInput.value = "";
    renderCart();
  }

  els.btnCheckout.disabled = false;
}

async function loadAdminOrders() {
  if (!isAdmin) return;
  const { data, error } = await supabaseClient
    .from("orders")
    .select("*, order_items(*)")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    els.adminOrders.innerHTML = `<p class="muted">Error cargando pedidos: ${error.message}</p>`;
    return;
  }

  if (!data?.length) {
    els.adminOrders.innerHTML = `<p class="muted">Aún no hay pedidos.</p>`;
    return;
  }

  els.adminOrders.innerHTML = data
    .map((o) => {
      const itemsHtml = (o.order_items || [])
        .map((it) => `<li>${it.quantity}x ${escapeHtml(it.product_name)} ($${Number(it.subtotal).toFixed(2)})</li>`)
        .join("");

      return `
        <div class="card">
          <div class="row-between">
            <strong>Pedido #${o.order_number} · ${escapeHtml(o.customer_name)}</strong>
            <strong>$${Number(o.total).toFixed(2)}</strong>
          </div>
          <p class="muted">${o.delivery_type === "delivery" ? "A domicilio: " + escapeHtml(o.address) : "Recoger en local"}</p>
          ${o.notes ? `<p class="muted">Nota: ${escapeHtml(o.notes)}</p>` : ""}
          <ul style="margin: 8px 0; padding-left: 18px;">${itemsHtml}</ul>
          <div class="row-between">
            <span class="muted">Estado actual: <strong>${o.status}</strong></span>
            <select onchange="updateOrderStatus('${o.id}', this.value)">
              ${["pending", "preparing", "out_for_delivery", "completed", "cancelled"]
                .map((st) => `<option value="${st}" ${o.status === st ? "selected" : ""}>${st}</option>`)
                .join("")}
            </select>
          </div>
        </div>
      `;
    })
    .join("");
}

window.updateOrderStatus = async function (orderId, status) {
  await supabaseClient.from("orders").update({ status }).eq("id", orderId);
};

function renderAdminProducts() {
  els.adminProducts.innerHTML = products
    .map(
      (p) => `
      <div class="card row-between">
        <div>
          <strong>${escapeHtml(p.name)}</strong>
          <div class="muted">${p.is_available ? "Disponible" : "Agotado"}</div>
        </div>
        <div class="row-between">
          <input
            type="number"
            step="0.5"
            value="${Number(p.price)}"
            style="width: 90px;"
            onchange="updateProductPrice('${p.id}', this.value)"
          />
          <button onclick="toggleProductAvailability('${p.id}', ${!p.is_available})">
            ${p.is_available ? "Marcar agotado" : "Activar"}
          </button>
        </div>
      </div>
    `
    )
    .join("");
}

window.toggleProductAvailability = async function (productId, nextAvailable) {
  await supabaseClient
    .from("products")
    .update({ is_available: nextAvailable })
    .eq("id", productId);
};

window.updateProductPrice = async function (productId, nextPrice) {
  const parsed = Number(nextPrice);
  if (Number.isNaN(parsed) || parsed < 0) return;
  await supabaseClient.from("products").update({ price: parsed }).eq("id", productId);
};

function subscribeRealtime() {
  supabaseClient
    .channel("public-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "products" },
      async () => {
        await loadProducts();
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "orders" },
      async () => {
        if (isAdmin) await loadAdminOrders();
      }
    )
    .subscribe();
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Ejemplo de cambio de estado de pedido y disponibilidad en Supabase
async function updateOrderStatus(orderId, nextStatus) {
  const { error } = await supabaseClient
    .from("orders")
    .update({ status: nextStatus })
    .eq("id", orderId);

  if (error) {
    tg.showAlert("No se pudo actualizar el estado del pedido.");
    return;
  }
  await loadAdminOrders();
}

async function toggleProductAvailability(productId, currentValue) {
  const { error } = await supabaseClient
    .from("products")
    .update({ is_available: !currentValue, updated_at: new Date().toISOString() })
    .eq("id", productId);

  if (error) {
    tg.showAlert("No se pudo cambiar la disponibilidad.");
    return;
  }
  await loadAdminProducts();
}

async function updateProductPrice(productId, newPrice) {
  const numericPrice = Number(newPrice);
  if (Number.isNaN(numericPrice) || numericPrice <= 0) {
    tg.showAlert("Ingresa un precio válido.");
    return;
  }

  const { error } = await supabaseClient
    .from("products")
    .update({ price: numericPrice, updated_at: new Date().toISOString() })
    .eq("id", productId);

  if (error) {
    tg.showAlert("No se pudo guardar el precio.");
    return;
  }
  tg.showPopup({ title: "Listo", message: "Precio actualizado.", buttons: [{ type: "ok" }] });
}

init();