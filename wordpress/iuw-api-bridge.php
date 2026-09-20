<?php
/**
 * Plugin Name: ICE UNDERWATER API Bridge
 * Description: Minimal mu-plugin bridge for the Node API — credential verify, user create, invoice send, custom roles.
 * Author: ICE UNDERWATER
 *
 * Setup:
 * 1. Copy this file to wp-content/mu-plugins/iuw-api-bridge.php
 * 2. Add to wp-config.php:
 *      define('IUW_BRIDGE_SECRET', 'same-value-as-WP_BRIDGE_SECRET');
 *      define('IUW_BRIDGE_ALLOWED_IPS', '1.2.3.4'); // comma-separated API server IPs; empty = secret-only
 * 3. No other WordPress work is required for the Node API.
 * Product create/update/delete and media upload run as a WordPress administrator
 * so WooCommerce REST keys (which often lack publish_products) are not required.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'init', 'iuw_bridge_register_roles' );
add_action( 'rest_api_init', 'iuw_bridge_register_routes' );

function iuw_bridge_register_roles() {
	add_role(
		'iuw_supplier',
		'IUW Supplier',
		array(
			'read' => true,
		)
	);
	add_role(
		'iuw_admin',
		'IUW Admin',
		array(
			'read'         => true,
			'list_users'   => true,
			'edit_users'   => true,
			'promote_users'=> true,
		)
	);
}

function iuw_bridge_register_routes() {
	register_rest_route(
		'iuw-bridge/v1',
		'/verify',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_verify',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/create-user',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_create_user',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/send-invoice',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_send_invoice',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/upload-media',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_upload_media',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/products',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_create_product',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/products/(?P<id>\d+)',
		array(
			array(
				'methods'             => 'POST, PUT, PATCH',
				'callback'            => 'iuw_bridge_update_product',
				'permission_callback' => 'iuw_bridge_authorize',
			),
			array(
				'methods'             => 'DELETE',
				'callback'            => 'iuw_bridge_delete_product',
				'permission_callback' => 'iuw_bridge_authorize',
			),
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/products/(?P<id>\d+)/delete',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_delete_product',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);
}

function iuw_bridge_authorize( WP_REST_Request $request ) {
	$secret = defined( 'IUW_BRIDGE_SECRET' ) ? IUW_BRIDGE_SECRET : '';
	$header = $request->get_header( 'x_iuw_bridge_secret' );
	if ( ! $secret || ! hash_equals( $secret, (string) $header ) ) {
		return new WP_Error( 'iuw_bridge_forbidden', 'Forbidden', array( 'status' => 403 ) );
	}

	$allowed = defined( 'IUW_BRIDGE_ALLOWED_IPS' ) ? IUW_BRIDGE_ALLOWED_IPS : '';
	if ( $allowed ) {
		$ips  = array_filter( array_map( 'trim', explode( ',', $allowed ) ) );
		$remote = isset( $_SERVER['REMOTE_ADDR'] ) ? $_SERVER['REMOTE_ADDR'] : '';
		if ( $ips && ! in_array( $remote, $ips, true ) ) {
			return new WP_Error( 'iuw_bridge_forbidden', 'Forbidden', array( 'status' => 403 ) );
		}
	}

	return true;
}

function iuw_bridge_verify( WP_REST_Request $request ) {
	$email    = sanitize_email( (string) $request->get_param( 'email' ) );
	$password = (string) $request->get_param( 'password' );
	if ( ! $email || ! $password ) {
		return new WP_Error( 'iuw_bridge_invalid', 'Email and password are required.', array( 'status' => 400 ) );
	}

	$user = wp_authenticate( $email, $password );
	if ( is_wp_error( $user ) ) {
		$user = wp_authenticate( sanitize_user( $email, true ), $password );
	}
	if ( is_wp_error( $user ) ) {
		return new WP_Error( 'iuw_bridge_invalid_login', 'The login details are incorrect.', array( 'status' => 401 ) );
	}

	return iuw_bridge_user_payload( $user );
}

function iuw_bridge_create_user( WP_REST_Request $request ) {
	$email        = sanitize_email( (string) $request->get_param( 'email' ) );
	$password     = (string) $request->get_param( 'password' );
	$display_name = sanitize_text_field( (string) $request->get_param( 'displayName' ) );
	$roles        = (array) $request->get_param( 'roles' );

	if ( ! $email || ! $password ) {
		return new WP_Error( 'iuw_bridge_invalid', 'Email and password are required.', array( 'status' => 400 ) );
	}
	if ( email_exists( $email ) ) {
		return new WP_Error( 'iuw_bridge_exists', 'An account with this email already exists.', array( 'status' => 409 ) );
	}

	$user_id = wp_insert_user(
		array(
			'user_login'   => $email,
			'user_email'   => $email,
			'user_pass'    => $password,
			'display_name' => $display_name ? $display_name : $email,
			'role'         => 'subscriber',
		)
	);

	if ( is_wp_error( $user_id ) ) {
		return $user_id;
	}

	$user = new WP_User( $user_id );
	$user->set_role( 'subscriber' );
	foreach ( $roles as $role ) {
		$role = sanitize_key( (string) $role );
		if ( $role ) {
			$user->add_role( $role );
		}
	}

	return iuw_bridge_user_payload( $user );
}

function iuw_bridge_send_invoice( WP_REST_Request $request ) {
	if ( ! function_exists( 'wc_get_order' ) ) {
		return new WP_Error( 'iuw_bridge_woo', 'WooCommerce is required.', array( 'status' => 503 ) );
	}

	$order_id = absint( $request->get_param( 'orderId' ) );
	$order    = wc_get_order( $order_id );
	if ( ! $order ) {
		return new WP_Error( 'iuw_bridge_order', 'Order not found.', array( 'status' => 404 ) );
	}

	// Trigger WooCommerce's own customer invoice email (branded template).
	WC()->mailer()->customer_invoice( $order );
	$order->add_order_note( 'Invoice email triggered by ICE UNDERWATER API bridge.' );

	return array(
		'ok'      => true,
		'orderId' => $order_id,
		'to'      => $order->get_billing_email(),
	);
}

function iuw_bridge_acting_admin_id() {
	if ( defined( 'IUW_BRIDGE_WP_USER_ID' ) && IUW_BRIDGE_WP_USER_ID ) {
		return absint( IUW_BRIDGE_WP_USER_ID );
	}

	$admins = get_users(
		array(
			'role'    => 'administrator',
			'number'  => 1,
			'orderby' => 'ID',
			'order'   => 'ASC',
		)
	);

	return empty( $admins ) ? 0 : (int) $admins[0]->ID;
}

function iuw_bridge_as_admin() {
	$admin_id = iuw_bridge_acting_admin_id();
	if ( $admin_id ) {
		wp_set_current_user( $admin_id );
	}
}

function iuw_bridge_create_product( WP_REST_Request $request ) {
	if ( ! class_exists( 'WC_Product_Simple' ) ) {
		return new WP_Error( 'iuw_bridge_woo', 'WooCommerce is required.', array( 'status' => 503 ) );
	}

	iuw_bridge_as_admin();
	$product = new WC_Product_Simple();
	iuw_bridge_apply_product_data( $product, $request, true );
	$id      = $product->save();
	if ( ! $id ) {
		return new WP_Error( 'iuw_bridge_product', 'Could not create the product.', array( 'status' => 500 ) );
	}

	$saved = wc_get_product( $id );
	if ( ! $saved ) {
		return new WP_Error( 'iuw_bridge_product', 'Could not load the product after save.', array( 'status' => 500 ) );
	}

	return iuw_bridge_product_payload( $saved );
}

function iuw_bridge_update_product( WP_REST_Request $request ) {
	if ( ! function_exists( 'wc_get_product' ) ) {
		return new WP_Error( 'iuw_bridge_woo', 'WooCommerce is required.', array( 'status' => 503 ) );
	}

	iuw_bridge_as_admin();
	$product = wc_get_product( absint( $request['id'] ) );
	if ( ! $product ) {
		return new WP_Error( 'iuw_bridge_product', 'Product not found.', array( 'status' => 404 ) );
	}

	iuw_bridge_apply_product_data( $product, $request, false );
	$product->save();
	$saved = wc_get_product( $product->get_id() );

	return iuw_bridge_product_payload( $saved ? $saved : $product );
}

function iuw_bridge_delete_product( WP_REST_Request $request ) {
	if ( ! function_exists( 'wc_get_product' ) ) {
		return new WP_Error( 'iuw_bridge_woo', 'WooCommerce is required.', array( 'status' => 503 ) );
	}

	iuw_bridge_as_admin();
	$product = wc_get_product( absint( $request['id'] ) );
	if ( ! $product ) {
		return new WP_Error( 'iuw_bridge_product', 'Product not found.', array( 'status' => 404 ) );
	}

	$product->delete( false );

	return array(
		'id'     => absint( $request['id'] ),
		'status' => 'deleted',
	);
}

function iuw_bridge_apply_product_data( WC_Product $product, WP_REST_Request $request, $creating ) {
	$params = $request->get_json_params();
	if ( ! is_array( $params ) ) {
		$params = $request->get_params();
	}

	$has = function ( $key ) use ( $params, $creating ) {
		return $creating || array_key_exists( $key, $params );
	};

	if ( $has( 'name' ) ) {
		$product->set_name( sanitize_text_field( (string) $request->get_param( 'name' ) ) );
	}
	if ( $has( 'description' ) ) {
		$product->set_description( wp_kses_post( (string) $request->get_param( 'description' ) ) );
	}
	if ( $has( 'short_description' ) ) {
		$product->set_short_description( wp_kses_post( (string) $request->get_param( 'short_description' ) ) );
	}
	if ( $has( 'regular_price' ) ) {
		$product->set_regular_price( wc_format_decimal( (string) $request->get_param( 'regular_price' ) ) );
	}
	if ( $has( 'status' ) ) {
		$status = sanitize_key( (string) $request->get_param( 'status' ) );
		$product->set_status( $status ? $status : 'publish' );
	}
	if ( $has( 'catalog_visibility' ) ) {
		$product->set_catalog_visibility( sanitize_key( (string) $request->get_param( 'catalog_visibility' ) ) );
	}
	if ( $has( 'manage_stock' ) || $creating ) {
		$product->set_manage_stock( true );
	}
	if ( $has( 'stock_quantity' ) ) {
		$product->set_stock_quantity( intval( $request->get_param( 'stock_quantity' ) ) );
	}
	if ( $has( 'stock_status' ) ) {
		$stock_status = sanitize_key( (string) $request->get_param( 'stock_status' ) );
		$product->set_stock_status( $stock_status ? $stock_status : 'instock' );
	}
	if ( $has( 'categories' ) ) {
		$categories = (array) $request->get_param( 'categories' );
		$ids        = array();
		foreach ( $categories as $category ) {
			if ( is_array( $category ) && isset( $category['id'] ) ) {
				$ids[] = absint( $category['id'] );
			} elseif ( is_numeric( $category ) ) {
				$ids[] = absint( $category );
			}
		}
		$product->set_category_ids( $ids );
	}
	if ( $has( 'images' ) ) {
		$images = (array) $request->get_param( 'images' );
		$first  = isset( $images[0] ) ? $images[0] : null;
		$image_id = is_array( $first ) && isset( $first['id'] ) ? absint( $first['id'] ) : 0;
		if ( $image_id ) {
			$product->set_image_id( $image_id );
		}
	}

	$meta = $request->get_param( 'meta_data' );
	if ( is_array( $meta ) ) {
		foreach ( $meta as $row ) {
			if ( ! is_array( $row ) || empty( $row['key'] ) ) {
				continue;
			}
			$product->update_meta_data( sanitize_text_field( (string) $row['key'] ), $row['value'] );
		}
	}
}

function iuw_bridge_product_payload( WC_Product $product ) {
	$categories = array();
	foreach ( $product->get_category_ids() as $term_id ) {
		$term = get_term( $term_id, 'product_cat' );
		$categories[] = array(
			'id'   => (int) $term_id,
			'name' => ( $term && ! is_wp_error( $term ) ) ? $term->name : '',
		);
	}

	$images = array();
	$image_id = $product->get_image_id();
	if ( $image_id ) {
		$images[] = array(
			'id'  => (int) $image_id,
			'src' => wp_get_attachment_url( $image_id ),
		);
	}

	$meta_data = array();
	foreach ( $product->get_meta_data() as $meta ) {
		$meta_data[] = array(
			'key'   => $meta->key,
			'value' => $meta->value,
		);
	}

	return array(
		'id'                 => $product->get_id(),
		'name'               => $product->get_name(),
		'status'             => $product->get_status(),
		'regular_price'      => (string) $product->get_regular_price(),
		'price'              => (string) $product->get_price(),
		'stock_quantity'     => $product->get_stock_quantity(),
		'description'        => $product->get_description(),
		'short_description'  => $product->get_short_description(),
		'categories'         => $categories,
		'images'             => $images,
		'meta_data'          => $meta_data,
	);
}

function iuw_bridge_upload_media( WP_REST_Request $request ) {
	iuw_bridge_as_admin();
	$filename = sanitize_file_name( (string) $request->get_param( 'filename' ) );
	$mime     = sanitize_text_field( (string) $request->get_param( 'mime' ) );
	$data     = (string) $request->get_param( 'data' );

	if ( ! $filename ) {
		$filename = 'upload.jpg';
	}
	if ( ! preg_match( '/\.(jpe?g|png|webp)$/i', $filename ) ) {
		$filename .= '.jpg';
	}
	if ( ! $data ) {
		return new WP_Error( 'iuw_bridge_invalid', 'Image data is required.', array( 'status' => 400 ) );
	}

	$binary = base64_decode( $data, true );
	if ( false === $binary || ! $binary ) {
		return new WP_Error( 'iuw_bridge_invalid', 'Invalid image data.', array( 'status' => 400 ) );
	}

	$upload = wp_upload_bits( $filename, null, $binary );
	if ( ! empty( $upload['error'] ) ) {
		return new WP_Error( 'iuw_bridge_upload', (string) $upload['error'], array( 'status' => 500 ) );
	}

	$filetype   = wp_check_filetype( $filename, null );
	$attachment = array(
		'post_mime_type' => $mime ? $mime : ( $filetype['type'] ? $filetype['type'] : 'image/jpeg' ),
		'post_title'     => preg_replace( '/\.[^.]+$/', '', $filename ),
		'post_content'   => '',
		'post_status'    => 'inherit',
		'post_author'    => iuw_bridge_acting_admin_id(),
		'guid'           => $upload['url'],
	);

	$attach_id = wp_insert_attachment( $attachment, $upload['file'] );
	if ( is_wp_error( $attach_id ) ) {
		return $attach_id;
	}

	require_once ABSPATH . 'wp-admin/includes/image.php';
	wp_update_attachment_metadata( $attach_id, wp_generate_attachment_metadata( $attach_id, $upload['file'] ) );

	return array(
		'id'        => (int) $attach_id,
		'sourceUrl' => esc_url_raw( $upload['url'] ),
	);
}

function iuw_bridge_user_payload( WP_User $user ) {
	return array(
		'wpUserId'    => (int) $user->ID,
		'email'       => $user->user_email,
		'displayName' => $user->display_name,
		'roles'       => array_values( $user->roles ),
	);
}

/**
 * Accept-then-pay: stash iuw_request_id from the checkout URL onto the Woo order
 * so the API webhook can match order + customer + request.
 */
add_action( 'init', 'iuw_bridge_capture_request_id' );
function iuw_bridge_capture_request_id() {
	if ( empty( $_GET['iuw_request_id'] ) ) {
		return;
	}
	$request_id = sanitize_text_field( wp_unslash( (string) $_GET['iuw_request_id'] ) );
	if ( $request_id === '' ) {
		return;
	}
	if ( ! function_exists( 'WC' ) || ! WC()->session ) {
		return;
	}
	WC()->session->set( 'iuw_request_id', $request_id );
}

add_action( 'woocommerce_checkout_create_order', 'iuw_bridge_attach_request_id_to_order', 20, 2 );
function iuw_bridge_attach_request_id_to_order( $order, $data ) {
	$request_id = '';
	if ( function_exists( 'WC' ) && WC()->session ) {
		$request_id = (string) WC()->session->get( 'iuw_request_id' );
	}
	if ( $request_id === '' && ! empty( $_GET['iuw_request_id'] ) ) {
		$request_id = sanitize_text_field( wp_unslash( (string) $_GET['iuw_request_id'] ) );
	}
	if ( $request_id === '' ) {
		return;
	}
	$order->update_meta_data( 'iuw_request_id', $request_id );
}
